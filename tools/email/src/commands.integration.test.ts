import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runCommand, UsageError } from "./commands.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("email admin CLI on a throwaway database (W3-G2.16-rest)", () => {
  let handle: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const slug = `mail-${run}`;
  const domain = `mail-${run}.harbor.example`;

  beforeAll(async () => {
    if (!env) return;
    handle = createDb(env.adminUrl, { max: 1 });
    await handle.sql`insert into public.tenants (id, slug, display_name)
      values (${randomUUID()}, ${slug}, 'Mail CLI Tenant')`;
  });
  afterAll(async () => {
    await handle?.end();
  });

  it("adds, verifies, and retires a domain, and reports each state", async () => {
    expect(await runCommand(handle.db, { kind: "domain-status", slug })).toEqual([
      `${slug}: no sending domain; mail uses the shared sender`,
    ]);
    const added = await runCommand(handle.db, {
      kind: "domain-add",
      slug,
      domain,
      mailbox: "trips",
    });
    expect(added[0]).toBe(`${domain}: pending. Nothing sends from it until it is verified.`);
    expect(await runCommand(handle.db, { kind: "domain-status", slug })).toEqual([
      `trips@${domain}  pending`,
    ]);
    const verify = {
      kind: "domain-verify",
      slug,
      domain,
      evidence: "SPF DKIM DMARC pass",
    } as const;
    expect(await runCommand(handle.db, verify)).toEqual([`${domain}: verified`]);
    expect(await runCommand(handle.db, verify)).toEqual([`${domain}: already verified`]);
    const [line] = await runCommand(handle.db, { kind: "domain-status", slug });
    expect(line).toMatch(
      new RegExp(`^trips@${domain.replaceAll(".", "\\.")}  verified  verified at `),
    );
    const retire = { kind: "domain-retire", slug, domain, reason: "moved" } as const;
    expect(await runCommand(handle.db, retire)).toEqual([`${domain}: retired`]);
    expect(await runCommand(handle.db, retire)).toEqual([`${domain}: no live domain of that name`]);
    const audit = await handle.sql<{ action: string; actor_type: string; actor_id: string }[]>`
      select a.action, a.actor_type, a.actor_id from public.audit_events a
        join public.tenants t on t.id = a.tenant_id
       where t.slug = ${slug} and a.subject_type = 'tenant_sender_domain' order by a.id`;
    expect(audit).toEqual([
      { action: "email.sender_domain_added", actor_type: "support", actor_id: "email-cli" },
      { action: "email.sender_domain_verified", actor_type: "support", actor_id: "email-cli" },
      { action: "email.sender_domain_retired", actor_type: "support", actor_id: "email-cli" },
    ]);
  });

  it("reports suppressions as counts and lifts nothing that is not suppressed", async () => {
    expect(await runCommand(handle.db, { kind: "suppressions", slug })).toEqual([
      `${slug}: no suppressed addresses`,
    ]);
    expect(
      await runCommand(handle.db, {
        kind: "suppression-lift",
        slug,
        address: "nobody@example.test",
        reason: "test",
      }),
    ).toEqual(["that address is not suppressed for this tenant"]);
  });

  it("names an unknown tenant as a usage error", async () => {
    await expect(
      runCommand(handle.db, { kind: "domain-status", slug: `none-${run}` }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
