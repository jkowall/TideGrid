/**
 * W3-OPS-4: signed PDFs in a private evidence bucket (migration 0053).
 *
 * - With a bucket, signing writes the PDF under waivers/<tenant>/<sha256>.pdf
 *   before the evidence row, and the row keeps the key, size, and hash, with
 *   no bytes.
 * - Reads hash the bytes again: changed bytes are refused, missing bytes are
 *   refused, and a bucket row is never read without the bucket.
 * - A bucket that refuses the write leaves no evidence and the request pending.
 * - Rows written before (bytes in the row) still load, with or without a bucket.
 * - The database holds every row to exactly one place, with the key fixed by
 *   the tenant and the hash.
 */
import { createHash, randomUUID } from "node:crypto";
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  evidenceDocumentKey,
  loadEvidenceDocument,
  type WaiverDeps,
  WaiverDocumentMismatchError,
  WaiverDocumentMissingError,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  fixtureDeps,
  fixtureDepsWithStore,
  fixtureHooks,
  MemoryEvidenceStore,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  book,
  closeWorld,
  guestCtx,
  liveRequest,
  name,
  openFor,
  openWorld,
  refusal,
  sign,
  trips,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-OPS-4: signed PDFs in the evidence bucket", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let hooks: BookingHooks;
  let plain: WaiverDeps;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 6);
    plain = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvb", { days: 6 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  const read = (filter: { requestId: string } | { evidenceId: string }, deps: WaiverDeps) =>
    inTenantTransaction(world.db, guestCtx(A.id), (trx) =>
      loadEvidenceDocument(trx, A.id, filter, deps.documents),
    );

  async function signedRequest(deps: WaiverDeps, label: string) {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult(label), hooks);
    const request = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const { session } = await openFor(world, A.id, request);
    const result = await sign(world, A.id, deps, session);
    return { request, session, result };
  }

  it("writes the PDF to the bucket under its content address and keeps only the key in the row", async () => {
    const store = new MemoryEvidenceStore();
    const deps = fixtureDepsWithStore(store);
    const { request, result } = await signedRequest(deps, "Bea Bucket");
    expect(result.kind).toBe("signed");
    const [row] = await world.admin<
      {
        id: string;
        document: Buffer | null;
        document_key: string;
        document_size: number;
        document_sha256: string;
      }[]
    >`select id, document, document_key, document_size, document_sha256
        from public.waiver_evidence where request_id = ${request}`;
    if (!row) throw new Error("no evidence");
    expect(row.document).toBeNull();
    expect(row.document_key).toBe(evidenceDocumentKey(A.id, row.document_sha256));
    expect(row.document_key).toBe(`waivers/${A.id}/${row.document_sha256}.pdf`);
    const held = store.objects.get(row.document_key);
    if (!held) throw new Error("the bucket has no object");
    expect(held.byteLength).toBe(row.document_size);
    expect(createHash("sha256").update(held).digest("hex")).toBe(row.document_sha256);
    expect(Buffer.from(held.subarray(0, 5)).toString("latin1")).toBe("%PDF-");

    const loaded = await read({ requestId: request }, deps);
    expect(loaded?.evidenceId).toBe(row.id);
    expect(loaded?.sha256).toBe(row.document_sha256);
    expect(Buffer.compare(Buffer.from(loaded?.document ?? []), Buffer.from(held))).toBe(0);
    const byId = await read({ evidenceId: row.id }, deps);
    expect(byId?.sha256).toBe(row.document_sha256);

    // Without the bucket the row's PDF cannot be read, and is never faked.
    const without = await read({ evidenceId: row.id }, plain).then(
      () => null,
      (err: unknown) => err,
    );
    expect(without).toBeInstanceOf(WaiverDocumentMissingError);
  }, 120_000);

  it("refuses bytes changed or lost in the bucket", async () => {
    const store = new MemoryEvidenceStore();
    const deps = fixtureDepsWithStore(store);
    const { request } = await signedRequest(deps, "Tom Tamper");
    const [row] = await world.admin<{ id: string; document_key: string }[]>`
      select id, document_key from public.waiver_evidence where request_id = ${request}`;
    if (!row) throw new Error("no evidence");
    const held = store.objects.get(row.document_key);
    if (!held) throw new Error("no object");

    const changed = new Uint8Array(held.byteLength + 1);
    changed.set(held);
    store.objects.set(row.document_key, changed);
    const mismatch = await read({ requestId: request }, deps).then(
      () => null,
      (err: unknown) => err,
    );
    expect(mismatch).toBeInstanceOf(WaiverDocumentMismatchError);
    expect((mismatch as WaiverDocumentMismatchError).evidenceId).toBe(row.id);

    store.objects.delete(row.document_key);
    const missing = await read({ evidenceId: row.id }, deps).then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toBeInstanceOf(WaiverDocumentMissingError);
    expect((missing as WaiverDocumentMissingError).evidenceId).toBe(row.id);
  }, 120_000);

  it("commits no signature when the bucket refuses the write, and signs on a retry", async () => {
    const store = new MemoryEvidenceStore();
    const deps = fixtureDepsWithStore(store);
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Fay Failure"), hooks);
    const request = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const { session } = await openFor(world, A.id, request);
    store.failNext = true;
    const failed = await sign(world, A.id, deps, session).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(Error);
    const before = await world.admin<{ state: string; evidence: number }[]>`
      select r.state, (select count(*)::int from public.waiver_evidence e where e.request_id = r.id) as evidence
        from public.waiver_requests r where r.id = ${request}`;
    expect(before).toEqual([{ state: "pending", evidence: 0 }]);
    expect(store.objects.size).toBe(0);

    const retried = await sign(world, A.id, deps, session);
    expect(retried.kind).toBe("signed");
    expect(store.objects.size).toBe(1);
  }, 120_000);

  it("still loads a PDF kept in the row, with or without a bucket", async () => {
    const { request, result } = await signedRequest(plain, "Olga Older");
    expect(result.kind).toBe("signed");
    const [row] = await world.admin<
      { document_key: string | null; document_size: number | null }[]
    >`
      select document_key, document_size from public.waiver_evidence where request_id = ${request}`;
    expect(row).toEqual({ document_key: null, document_size: null });
    const withBucket = await read(
      { requestId: request },
      fixtureDepsWithStore(new MemoryEvidenceStore()),
    );
    const withoutBucket = await read({ requestId: request }, plain);
    expect(withBucket?.sha256).toBe(withoutBucket?.sha256);
    expect(withBucket?.document.byteLength).toBeGreaterThan(64);
  }, 120_000);

  it("holds each row to one place, with the key fixed by the tenant and the hash", async () => {
    const store = new MemoryEvidenceStore();
    const { request } = await signedRequest(fixtureDepsWithStore(store), "Kit Keyed");
    // A copy of a real row with new ids, inserted by the owner with triggers
    // and foreign keys off (replica mode) inside a rolled-back transaction, so
    // only the table's checks decide.
    const attempt = (set: string) =>
      refusal(
        world.admin.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx.unsafe(
            `insert into public.waiver_evidence
               select (r).* from (
                 select jsonb_populate_record(e, jsonb_build_object(
                          'id', '${randomUUID()}', 'request_id', '${randomUUID()}') || ${set}) as r
                   from public.waiver_evidence e where e.request_id = '${request}') s`,
          );
          throw new Error("rolled back");
        }),
      );
    // The real row's shape passes the checks (only the rollback stops it).
    expect(await attempt("'{}'::jsonb")).toBe("no-code");
    expect(
      await attempt(
        `jsonb_build_object('document_key', 'waivers/${randomUUID()}/' || e.document_sha256 || '.pdf')`,
      ),
    ).toContain("waiver_evidence_document_place");
    expect(
      await attempt(
        `jsonb_build_object('document_key', 'waivers/' || e.tenant_id || '/${"0".repeat(64)}.pdf')`,
      ),
    ).toContain("waiver_evidence_document_place");
    expect(await attempt(`jsonb_build_object('document_key', null)`)).toContain(
      "waiver_evidence_document_place",
    );
    expect(await attempt(`jsonb_build_object('document', '\\x255044462d')`)).toContain(
      "waiver_evidence",
    );
    expect(await attempt(`jsonb_build_object('document_size', 10)`)).toContain(
      "waiver_evidence_document_place",
    );
    expect(
      await attempt(`jsonb_build_object('document_key', null, 'document_size', null)`),
    ).toContain("waiver_evidence_document_place");
  }, 120_000);
});
