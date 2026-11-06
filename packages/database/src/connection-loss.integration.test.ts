import net from "node:net";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./index.ts";

const env = inject("integrationDb");

/**
 * A TCP relay to the test database that can go silent. After `silence()` it
 * drops every byte in both directions and ignores the client's FIN, but keeps
 * both sockets open: no reply, no FIN, no RST. That is what a client sees when
 * the far side sleeps, a NAT entry expires, or a network path drops. A clean
 * server-side close (pg_terminate_backend) does not reproduce it, because
 * postgres.js notices the close and finishes on its own.
 */
async function silentRelay(target: URL) {
  let silent = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({
      port: Number(target.port || 5432),
      host: target.hostname,
      allowHalfOpen: true,
    });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
    }
    client.on("data", (chunk) => silent || upstream.write(chunk));
    upstream.on("data", (chunk) => silent || client.write(chunk));
    client.on("end", () => silent || upstream.end());
    upstream.on("end", () => silent || client.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    silence: () => {
      silent = true;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function backendPid(handle: ReturnType<typeof createDb>): Promise<number> {
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(handle.db);
  return rows[0]?.pid ?? 0;
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

// The relay rewrites the host, so TLS with SNI (Neon) cannot pass through it.
// The local container and CI connect in plain TCP to 127.0.0.1.
const local = env ? ["127.0.0.1", "localhost"].includes(new URL(env.runtimeUrl).hostname) : false;

describe.skipIf(!env || !local)("createDb().end() is bounded", () => {
  let admin: postgres.Sql;
  beforeAll(() => {
    admin = postgres(env?.adminUrl ?? "", { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  it("returns at once on an idle connection whose peer answers (control)", async () => {
    const relay = await silentRelay(new URL(env?.runtimeUrl ?? ""));
    const handle = createDb(relay.url, { max: 1 });
    try {
      await backendPid(handle);
      expect(await timed(() => handle.end())).toBeLessThan(2_000);
    } finally {
      await handle.end();
      await relay.close();
    }
  });

  it("returns when an idle connection's peer went silent", async () => {
    // end() sends Terminate and waits for the socket to close. A silent peer
    // never closes it, so an unbounded end() waits forever.
    const relay = await silentRelay(new URL(env?.runtimeUrl ?? ""));
    const handle = createDb(relay.url, { max: 1 });
    let pid = 0;
    try {
      pid = await backendPid(handle);
      relay.silence();
      const elapsed = await timed(() => handle.end());
      // Only the 5 s timeout ends it. A fast end means the peer was not silent.
      expect(elapsed).toBeGreaterThan(4_000);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      // Close the relay first: its FIN releases an end() that is still waiting.
      await relay.close();
      await handle.end();
      if (pid) await admin`select pg_terminate_backend(${pid})`;
    }
  }, 30_000);

  it("returns when a query is still running", async () => {
    // Kysely runs each query on a reserved postgres.js connection. Ending one
    // mid-query waits for terminate(), which only the timeout calls.
    const handle = createDb(env?.runtimeUrl ?? "", { max: 1 });
    let pid = 0;
    try {
      pid = await backendPid(handle);
      const sleeping = sql`select pg_sleep(60)`.execute(handle.db);
      sleeping.catch(() => {});
      let active = false;
      for (let i = 0; i < 50 && !active; i++) {
        const [row] = await admin`select state from pg_stat_activity where pid = ${pid}`;
        active = row?.state === "active";
        if (!active) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(active).toBe(true);
      expect(await timed(() => handle.end())).toBeLessThan(10_000);
      await expect(sleeping).rejects.toMatchObject({ code: "CONNECTION_DESTROYED" });
    } finally {
      // A second end() reuses the first shutdown.
      await handle.end();
      if (pid) await admin`select pg_terminate_backend(${pid})`;
    }
  }, 30_000);
});
