import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { deployed, deployedEnv, openSignedIn, signIn, tenantManifests } from "./helpers.ts";

/**
 * Console isolation (Nov 1 runbook, P6 step 7; acceptance item 5), at 375 and
 * 1280. A one-tenant identity first proves, from /api/v1/me, that it holds
 * exactly one membership. Then it asks the console API for another tenant
 * B's booking detail, trip roster, a booking search by B's reference, and
 * B's day CSV, under B's tenant id. Every answer must be the same 404 or 403
 * error shape, with no B data in the body. The same identity then asks its
 * own tenant for B's booking, B's trip, and B's reference, which must find
 * nothing. The probe table is printed as one JSON line.
 *
 * Local (the console-browser CI job): Ava Owner, the owner of Demo Harbor
 * only, signs in with the local link. B is Demo Reef. B's booking is made
 * here, through the public API on :8981 at Demo Reef's local guest origin,
 * with the fake payment; its id, trip, and date come from the guest's own
 * management session. B's tenant id is the seed's fixed id for demo-reef
 * (tools/seed/src/seed.ts), read from that file. No admin URL is used.
 *
 * Deployed: the storage state is the one-tenant identity, and B's ids come
 * from E2E_FOREIGN_TENANT_ID, E2E_FOREIGN_BOOKING_ID, E2E_FOREIGN_TRIP_ID,
 * E2E_FOREIGN_REFERENCE, and E2E_FOREIGN_DATE, all required.
 */

interface Foreign {
  tenantId: string;
  bookingId: string;
  tripId: string;
  reference: string;
  /** The trip's local date at the marina, YYYY-MM-DD. */
  date: string;
  /** Known only locally, where this spec books B's guest. */
  booker?: { name: string; email: string };
}

interface Answer {
  status: number;
  text: string;
}

const LOCAL_API = "http://localhost:8981";
const LOCAL_REEF_ORIGIN = "http://demo-reef.book.localhost:5361";
const LOCAL_IDENTITY = "ava.owner@demo-harbor.test";

const fromEnv: Foreign | null = deployed
  ? {
      tenantId: deployedEnv("E2E_FOREIGN_TENANT_ID"),
      bookingId: deployedEnv("E2E_FOREIGN_BOOKING_ID"),
      tripId: deployedEnv("E2E_FOREIGN_TRIP_ID"),
      reference: deployedEnv("E2E_FOREIGN_REFERENCE"),
      date: deployedEnv("E2E_FOREIGN_DATE"),
    }
  : null;

/** Demo Reef's tenant id, as the seed fixes it. */
function seededReefId(): string {
  const seed = readFileSync(new URL("../../../tools/seed/src/seed.ts", import.meta.url), "utf8");
  const id = /id: "([0-9a-f-]{36})",\s*slug: "demo-reef"/.exec(seed)?.[1];
  if (!id) throw new Error("tools/seed/src/seed.ts no longer names demo-reef's tenant id");
  return id;
}

/** One public API call at Demo Reef's local guest origin. */
async function reef(
  request: APIRequestContext,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; bearer?: string; key?: boolean } = {},
) {
  const headers: Record<string, string> = { origin: LOCAL_REEF_ORIGIN };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.key) headers["idempotency-key"] = `isolation-${randomUUID()}`;
  const res = await request.fetch(`${LOCAL_API}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { data: options.body }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status(), json };
}

/**
 * Local only: book one Demo Reef guest through the public API and the fake
 * payment, and read the booking back through its management session. Four
 * public commands: the quote, the checkout, the payment, and the session.
 */
async function localForeignBooking(request: APIRequestContext): Promise<Foreign> {
  let tripId: string | undefined;
  for (let offset = 3; offset < 60 && !tripId; offset += 7) {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const { json } = await reef(
      request,
      "GET",
      `/v1/public/trips?from=${day(offset)}&to=${day(offset + 6)}&party=1`,
    );
    const trips = (json.trips ?? []) as { tripId: string; product: { kind: string } }[];
    tripId = trips.find((t) => t.product.kind === "shared_seat")?.tripId;
  }
  if (!tripId) throw new Error("no Demo Reef shared trip on sale in the next eight weeks");

  const offer = await reef(request, "GET", `/v1/public/trips/${tripId}/offer`);
  expect(offer.status, "the trip's offer").toBe(200);
  const ticket = ((offer.json.offer as { tickets?: { code: string }[] })?.tickets ?? [])[0]?.code;
  expect(ticket, "the trip's first ticket type").toBeTruthy();
  const quoted = await reef(request, "POST", "/v1/public/quotes", {
    key: true,
    body: {
      tripId,
      party: { kind: "tickets", tickets: [{ code: ticket, quantity: 1 }] },
      addOns: [],
    },
  });
  expect(quoted.status, "the quote").toBe(201);
  const quote = quoted.json.quote as { quoteId: string; policy: { version: number } };

  const booker = {
    name: "Isolation Reef Guest",
    email: `isolation.${randomBytes(4).toString("hex")}@guests.demo-reef.test`,
  };
  const secret = randomBytes(32).toString("base64url");
  const opened = await reef(request, "POST", "/v1/public/checkout-sessions", {
    key: true,
    body: {
      quoteId: quote.quoteId,
      acceptedPolicyVersion: quote.policy.version,
      booker,
      checkoutSecret: secret,
    },
  });
  expect(opened.status, "the checkout").toBe(201);
  const session = opened.json.checkoutSession as { id: string };
  const payment = opened.json.payment as { paymentRef: string; clientSecret: string };

  const paid = await reef(
    request,
    "POST",
    `/v1/fake-provider/payments/${payment.paymentRef}/succeed`,
    {
      bearer: payment.clientSecret,
      body: {},
    },
  );
  expect(paid.status, "the fake payment").toBe(200);
  await expect
    .poll(
      async () => {
        const read = await reef(request, "GET", `/v1/public/checkout-sessions/${session.id}`, {
          bearer: secret,
        });
        return (read.json.checkoutSession as { state?: string } | undefined)?.state;
      },
      { timeout: 20_000, message: "the checkout confirms" },
    )
    .toBe("confirmed");

  const manage = await reef(
    request,
    "POST",
    `/v1/public/checkout-sessions/${session.id}/manage-session`,
    { bearer: secret },
  );
  expect(manage.status, "the management session from checkout").toBe(201);
  const token = (manage.json.session as { token: string }).token;
  const read = await reef(request, "GET", "/v1/public/manage/booking", { bearer: token });
  expect(read.status, "the managed booking").toBe(200);
  const booking = read.json.booking as {
    id: string;
    reference: string;
    trip: { tripId: string; localDate: string };
  };
  return {
    tenantId: seededReefId(),
    bookingId: booking.id,
    tripId: booking.trip.tripId,
    reference: booking.reference,
    date: booking.trip.localDate,
    booker,
  };
}

/** A console API call from the signed-in page, the way the console makes it. */
async function consoleCall(page: Page, method: "GET" | "POST", path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }): Promise<Answer> => {
      const res = await fetch(path, {
        method,
        credentials: "same-origin",
        ...(body === null
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      return { status: res.status, text: await res.text() };
    },
    { method, path, body: body ?? null },
  );
}

/** The API's error shape: { error: { code, message, requestId } } and nothing else. */
function errorCode(answer: Answer): string | null {
  try {
    const parsed = JSON.parse(answer.text) as { error?: Record<string, unknown> };
    const keys = Object.keys(parsed).sort().join();
    const inner = Object.keys(parsed.error ?? {})
      .sort()
      .join();
    if (keys !== "error" || inner !== "code,message,requestId") return null;
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

test("a one-tenant identity reads nothing of another tenant through the console", async ({
  page,
  request,
}, info) => {
  const foreign = fromEnv ?? (await localForeignBooking(request));
  if (deployed) await openSignedIn(page);
  else await signIn(page, LOCAL_IDENTITY);

  // 1. Exactly one membership, and not B's.
  const me = await consoleCall(page, "GET", "/api/v1/me");
  expect(me.status, "/api/v1/me").toBe(200);
  const { memberships } = JSON.parse(me.text) as {
    memberships: { tenantId: string; tenantSlug: string }[];
  };
  expect(memberships.length, "memberships of the signed-in identity").toBe(1);
  const own = memberships[0] as { tenantId: string; tenantSlug: string };
  expect(own.tenantId).not.toBe(foreign.tenantId);
  if (!deployed) expect(own.tenantSlug).toBe("demo-harbor");

  // What no answer may carry: B's ids, any other tenant's slug or name, B's
  // booker, and, under B's tenant id, any address at all.
  const others = tenantManifests().filter((t) => t.slug !== own.tenantSlug);
  expect(others.length, "another tenant in config/tenants").toBeGreaterThan(0);
  const foreignData = [
    foreign.tenantId,
    foreign.bookingId,
    foreign.tripId,
    foreign.reference,
    ...others.flatMap((t) => [t.slug, ...t.names]),
    ...(foreign.booker ? [foreign.booker.name, foreign.booker.email] : []),
  ];
  const leaks = (answer: Answer) => foreignData.filter((value) => answer.text.includes(value));

  // 2. Under B's tenant id, the four probes. 3. Under its own tenant id, B's
  // booking, trip, and reference, which must find nothing.
  const theirs = `/api/v1/staff/tenants/${encodeURIComponent(foreign.tenantId)}`;
  const mine = `/api/v1/staff/tenants/${encodeURIComponent(own.tenantId)}`;
  const booking = encodeURIComponent(foreign.bookingId);
  const trip = encodeURIComponent(foreign.tripId);
  const plan: { probe: string; method: "GET" | "POST"; path: string; body?: unknown }[] = [
    { probe: "tenant B: booking detail", method: "GET", path: `${theirs}/bookings/${booking}` },
    { probe: "tenant B: trip roster", method: "GET", path: `${theirs}/trips/${trip}/roster` },
    {
      probe: "tenant B: search by reference",
      method: "POST",
      path: `${theirs}/booking-searches`,
      body: { q: foreign.reference },
    },
    {
      probe: "tenant B: day CSV",
      method: "GET",
      path: `${theirs}/booking-day-export?date=${encodeURIComponent(foreign.date)}`,
    },
    { probe: "own tenant: B's booking", method: "GET", path: `${mine}/bookings/${booking}` },
    { probe: "own tenant: B's trip roster", method: "GET", path: `${mine}/trips/${trip}/roster` },
    {
      probe: "own tenant: search by B's reference",
      method: "POST",
      path: `${mine}/booking-searches`,
      body: { q: foreign.reference },
    },
  ];
  const answers: Answer[] = [];
  for (const step of plan) answers.push(await consoleCall(page, step.method, step.path, step.body));
  const at = (i: number) => answers[i] as Answer;
  const leaksAt = (i: number) => {
    const found = leaks(at(i));
    // Under B's tenant id no answer carries an address of any kind.
    if (i < 4 && at(i).text.includes("@")) found.push("@");
    return found;
  };

  // The probe table, printed before any assertion so a failure still records it.
  console.log(
    JSON.stringify({
      check: "console-isolation",
      project: info.project.name,
      identityTenant: own.tenantSlug,
      memberships: memberships.length,
      probes: plan.map((step, i) => ({
        probe: step.probe,
        status: at(i).status,
        code: errorCode(at(i)),
        leaks: leaksAt(i).length,
      })),
    }),
  );

  const shapes = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const probe = plan[i]?.probe;
    expect([403, 404], `${probe}: a refusal`).toContain(at(i).status);
    expect(errorCode(at(i)), `${probe}: the error shape`).not.toBeNull();
    expect(leaksAt(i), `${probe}: no B data`).toEqual([]);
    shapes.add(`${at(i).status} ${errorCode(at(i))}`);
  }
  expect([...shapes], "tenant B: one refusal shape for every probe").toHaveLength(1);

  for (const [i, status] of [
    [4, 404],
    [5, 404],
    [6, 200],
  ] as const) {
    expect(at(i).status, plan[i]?.probe).toBe(status);
    expect(leaksAt(i), `${plan[i]?.probe}: no B data`).toEqual([]);
  }
  expect(JSON.parse(at(6).text)).toMatchObject({ results: [], total: 0 });
});
