/**
 * A recorded-shape Cloudflare for SaaS fixture for tests (G2.14b). It answers
 * the custom hostname endpoints the client uses from in-memory state, with
 * bodies modeled on the API reference, and it takes the same scripted
 * controls as the fake so one contract suite drives both. Synthetic names
 * only. Not exported from the package.
 *
 * Like Cloudflare, a POST answer leaves out `ssl.validation_records` (they
 * are generated a moment later), so the client's delayed read matters.
 *
 * API reference: https://developers.cloudflare.com/api/resources/custom_hostnames/
 */
import { fakeRawStatus, type HostnameAdvance, type HostnameProviderControls } from "./fake.ts";
import { mapCloudflareCertificateStatus } from "./status.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  search: [string, string][];
  authorization: boolean;
  body: unknown;
}

export interface ScriptedAnswer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FixtureRecord {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
  method: "txt" | "http";
  verificationErrors: string[];
  foreign: boolean;
  sequence: number;
  createdAt: string;
}

export interface CloudflareFixtureOptions {
  zoneId: string;
  apiToken: string;
  apiBase?: string;
}

export interface CloudflareFixture extends HostnameProviderControls {
  fetch: typeof fetch;
  /** Every request in order, faulted ones included. */
  readonly requests: RecordedRequest[];
  /** The next request matching `method` (any when omitted) gets this answer instead. */
  answerNext(answer: ScriptedAnswer, match?: { method?: string }): void;
  /** Ids and names held, in creation order. */
  records(): { id: string; hostname: string; foreign: boolean }[];
}

type Fault =
  | { kind: "status"; status: number; retryAfterSeconds: number | null }
  | { kind: "timeout" };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const failure = (status: number, code: number, message: string) =>
  json(status, { success: false, errors: [{ code, message }], messages: [], result: null });

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

export function createCloudflareFixture(options: CloudflareFixtureOptions): CloudflareFixture {
  const base = new URL(
    `${(options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "")}/zones/${options.zoneId}/custom_hostnames`,
  );
  const records = new Map<string, FixtureRecord>();
  const routed = new Set<string>();
  const faults: Fault[] = [];
  const scripted: { answer: ScriptedAnswer; method: string | undefined }[] = [];
  const requests: RecordedRequest[] = [];
  let loseNextCreate = false;
  let sequence = 0;

  const byName = (hostname: string) => {
    for (const record of records.values()) if (record.hostname === hostname) return record;
    return undefined;
  };

  const store = (hostname: string, method: "txt" | "http", foreign: boolean) => {
    sequence += 1;
    const record: FixtureRecord = {
      id: `${hex(sequence, 8)}-ad9f-4843-b99f-6cc0252067e9`,
      hostname,
      status: "pending",
      sslStatus: "pending_validation",
      method,
      verificationErrors: [],
      foreign,
      sequence,
      createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, sequence)).toISOString(),
    };
    records.set(record.id, record);
    return record;
  };

  /** A custom hostname object as the API reference shows it. */
  const render = (record: FixtureRecord, answer: "post" | "read") => {
    const certificate = mapCloudflareCertificateStatus(record.sslStatus);
    const token = `${hex(record.sequence, 8)}-5a5a-4b1d-9c3e-${hex(record.sequence, 12)}`;
    const ownership = `${hex(record.sequence, 8)}-0f0f-4e2a-8c11-${hex(record.sequence, 12)}`;
    const ssl: Record<string, unknown> = {
      id: `${hex(record.sequence, 8)}-1111-4222-8333-${hex(record.sequence, 12)}`,
      type: "dv",
      method: record.method,
      // A fresh certificate order reads `initializing` in the POST answer.
      status:
        answer === "post" && record.sslStatus === "pending_validation"
          ? "initializing"
          : record.sslStatus,
      bundle_method: "ubiquitous",
      certificate_authority: "google",
      wildcard: false,
      settings: { min_tls_version: "1.2", http2: "on" },
      hosts: [record.hostname],
    };
    if (answer === "read" && certificate !== "active" && certificate !== "expiring") {
      ssl.validation_records = [
        record.method === "http"
          ? {
              status: "pending",
              http_url: `http://${record.hostname}/.well-known/acme-challenge/${token}`,
              http_body: `${token}.ca3-2c5b6e1f`,
            }
          : {
              status: "pending",
              txt_name: `_acme-challenge.${record.hostname}`,
              txt_value: `ca3-${token}`,
            },
      ];
    }
    return {
      id: record.id,
      hostname: record.hostname,
      ssl,
      status: record.status,
      created_at: record.createdAt,
      custom_metadata: {},
      verification_errors: record.verificationErrors,
      ownership_verification: {
        type: "txt",
        name: `_cf-custom-hostname.${record.hostname}`,
        value: ownership,
      },
      ownership_verification_http: {
        http_url: `http://${record.hostname}/.well-known/cf-custom-hostname-challenge/${record.id}`,
        http_body: ownership,
      },
    };
  };

  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    json(200, { success: true, errors: [], messages: [], result, ...extra });

  const activateIfRouted = (record: FixtureRecord) => {
    if (!routed.has(record.hostname)) return;
    record.status = "active";
    record.sslStatus = "active";
    record.verificationErrors = [];
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const text = method === "GET" || method === "DELETE" ? "" : await request.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    requests.push({
      method,
      path: url.pathname,
      search: [...url.searchParams.entries()],
      authorization: request.headers.has("authorization"),
      body,
    });

    const fault = faults.shift();
    if (fault?.kind === "timeout") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (fault?.kind === "status") {
      const headers: Record<string, string> =
        fault.retryAfterSeconds === null ? {} : { "retry-after": String(fault.retryAfterSeconds) };
      if (fault.status === 429) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [
              { code: 971, message: "Please wait and consider throttling your request speed" },
            ],
            messages: [],
            result: null,
          }),
          { status: 429, headers: { "content-type": "application/json", ...headers } },
        );
      }
      // A 5xx from the edge is often an HTML page, not the JSON envelope.
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: fault.status,
        headers: { "content-type": "text/html", ...headers },
      });
    }
    const index = scripted.findIndex((s) => s.method === undefined || s.method === method);
    const script = index >= 0 ? scripted.splice(index, 1)[0] : undefined;
    if (script) {
      return new Response(script.answer.body, {
        status: script.answer.status,
        headers: script.answer.headers ?? { "content-type": "application/json" },
      });
    }

    if (request.headers.get("authorization") !== `Bearer ${options.apiToken}`) {
      return failure(403, 10000, "Authentication error");
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      return failure(
        404,
        7003,
        "Could not route to /zones, perhaps your object identifier is invalid?",
      );
    }
    const rest = url.pathname.slice(base.pathname.length);
    const id = rest.startsWith("/") ? rest.slice(1) : rest;
    if (rest !== "" && (!rest.startsWith("/") || id.includes("/") || id === "")) {
      return failure(404, 7003, "Could not route to the requested resource");
    }

    if (id === "" && method === "POST") {
      const input = body as { hostname?: unknown; ssl?: { method?: unknown } } | null;
      const hostname = typeof input?.hostname === "string" ? input.hostname : "";
      if (!hostname) return failure(400, 1409, "Hostname is required.");
      if (byName(hostname)) return failure(409, 1406, "Duplicate custom hostname found.");
      const record = store(hostname, input?.ssl?.method === "http" ? "http" : "txt", false);
      activateIfRouted(record);
      if (loseNextCreate) {
        loseNextCreate = false;
        throw new TypeError("Network connection lost.");
      }
      return ok(render(record, "post"));
    }
    if (id === "" && method === "GET") {
      const exact = url.searchParams.get("hostname.exact");
      const contain = url.searchParams.get("hostname.contain");
      const prefix = url.searchParams.get("hostname.startsWith");
      const all = [...records.values()].sort((a, b) => a.sequence - b.sequence);
      const found = all.filter((r) => {
        if (exact !== null) return r.hostname === exact;
        if (contain !== null) return r.hostname.includes(contain);
        if (prefix !== null) return r.hostname.startsWith(prefix);
        return true;
      });
      return ok(
        found.map((r) => render(r, "read")),
        {
          result_info: {
            page: 1,
            per_page: 20,
            count: found.length,
            total_count: all.length,
            total_pages: 1,
          },
        },
      );
    }
    const record = id ? records.get(id) : undefined;
    if (id && !record) return failure(404, 1436, "The custom hostname was not found.");
    if (record && method === "GET") return ok(render(record, "read"));
    if (record && method === "PATCH") {
      // Cloudflare re-runs validation on PATCH.
      activateIfRouted(record);
      return ok(render(record, "read"));
    }
    if (record && method === "DELETE") {
      records.delete(record.id);
      return ok({ id: record.id });
    }
    return failure(405, 10405, "Method not allowed");
  };

  const fixtureFetch = (async (input: Request | string | URL, init?: RequestInit) =>
    handle(new Request(input, init))) as typeof fetch;

  return {
    fetch: fixtureFetch,
    requests,
    answerNext(answer, match = {}) {
      scripted.push({ answer, method: match.method?.toUpperCase() });
    },
    records() {
      return [...records.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map((r) => ({ id: r.id, hostname: r.hostname, foreign: r.foreign }));
    },
    advance(hostname: string, change: HostnameAdvance) {
      const record = byName(hostname);
      if (!record) throw new Error(`the fixture holds no record for ${hostname}`);
      if (change.hostnameState) record.status = fakeRawStatus.hostname[change.hostnameState];
      if (change.certificateState) {
        record.sslStatus = fakeRawStatus.certificate[change.certificateState];
      }
      if (change.errors) {
        record.verificationErrors = change.errors.map(
          () => "custom hostname does not CNAME to this zone.",
        );
      }
    },
    failNext(fault) {
      faults.push({
        kind: "status",
        status: fault.status,
        retryAfterSeconds: fault.retryAfterSeconds ?? null,
      });
    },
    loseNextAnswer() {
      loseNextCreate = true;
    },
    timeoutNext() {
      faults.push({ kind: "timeout" });
    },
    cnamePresent(hostname: string) {
      routed.add(hostname);
    },
    plantRecord(hostname: string, plant: { foreign?: boolean } = {}) {
      if (byName(hostname)) throw new Error(`the fixture already holds ${hostname}`);
      store(hostname, "txt", plant.foreign ?? false);
    },
  };
}
