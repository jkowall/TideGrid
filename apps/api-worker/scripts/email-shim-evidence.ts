/**
 * Email shim evidence (lane 1, the G2.16 demo shim). Drives a running API
 * (`wrangler dev --test-scheduled`, EMAIL_PROVIDER=fake) through bookings
 * whose confirmation email goes through the fake provider, and records each
 * message's state and the fake's deliveries before and after every step:
 *
 * 1. the send after the booking commits, a provider redelivery of the payment
 *    event (twice), and repeated sweeps;
 * 2. a temporary failure, retried by the sweep once it is due;
 * 3. a permanent refusal, never retried;
 * 4. a send whose answer was lost after the provider accepted it, retried
 *    with the same idempotency key and not sent twice.
 *
 * It ends with the control total over every message the run made: at most
 * one accepted delivery each. It stands in for provider replay evidence, as
 * the payment shim's script does for Stripe.
 *
 *   API_URL=http://localhost:8901 \
 *   ORIGIN=http://demo-harbor.book.localhost:5301 \
 *   ADMIN_DATABASE_URL=<admin URL of the throwaway branch the API uses> \
 *   OUT=<file for the step log> \
 *   pnpm --filter @tidegrid/api-worker exec tsx scripts/email-shim-evidence.ts
 *
 * The admin connection reads state, makes time pass by moving a retry
 * earlier, and in step 4 files the provider's side of a lost answer, as the
 * fake would have. Never point it at the main branch. It prints identifiers,
 * templates, and states only, never secrets, tokens, or booker details.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

const api = process.env.API_URL ?? "http://localhost:8901";
const origin = process.env.ORIGIN ?? "http://demo-harbor.book.localhost:5301";
const sql = postgres(required("ADMIN_DATABASE_URL"), { max: 1, onnotice: () => {} });
const lines: string[] = [];

function log(line = ""): void {
  console.log(line);
  lines.push(line);
}

type Json = Record<string, unknown>;

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { origin, ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

interface Checkout {
  label: string;
  sessionId: string;
  paymentRef: string;
  clientSecret: string;
  tripId: string;
}

const used: string[] = [];

async function findTrip(party: number): Promise<string> {
  for (let offset = 3; offset < 60; offset += 7) {
    const from = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + (offset + 6) * 86_400_000).toISOString().slice(0, 10);
    const { json } = await call("GET", `/v1/public/trips?from=${from}&to=${to}&party=${party}`);
    const trips = (json.trips ?? []) as { tripId: string; product: { kind: string } }[];
    const found = trips.find((t) => t.product.kind === "shared_seat" && !used.includes(t.tripId));
    if (found) {
      used.push(found.tripId);
      return found.tripId;
    }
  }
  throw new Error(`no shared trip on sale for a party of ${party}`);
}

/** A checkout for one adult, by a booker at a reserved `.test` address. */
async function open(label: string, email: string): Promise<Checkout> {
  const tripId = await findTrip(1);
  const offer = await call("GET", `/v1/public/trips/${tripId}/offer`);
  const tickets = ((offer.json.offer as Json)?.tickets ?? []) as { code: string }[];
  const quoted = await call("POST", "/v1/public/quotes", {
    headers: { "idempotency-key": `email-q-${randomUUID()}` },
    body: {
      tripId,
      party: { kind: "tickets", tickets: [{ code: tickets[0]?.code ?? "adult", quantity: 1 }] },
      addOns: [],
    },
  });
  if (quoted.status !== 201) throw new Error(`quote ${quoted.status}`);
  const quote = quoted.json.quote as { quoteId: string; policy: { version: number } };
  const opened = await call("POST", "/v1/public/checkout-sessions", {
    headers: { "idempotency-key": `email-c-${randomUUID()}` },
    body: {
      quoteId: quote.quoteId,
      acceptedPolicyVersion: quote.policy.version,
      booker: { name: "Email Evidence Guest", email },
      checkoutSecret: randomBytes(32).toString("base64url"),
    },
  });
  if (opened.status !== 201) throw new Error(`checkout ${opened.status}`);
  const session = opened.json.checkoutSession as { id: string };
  const payment = opened.json.payment as { paymentRef: string; clientSecret: string };
  return {
    label,
    sessionId: session.id,
    paymentRef: payment.paymentRef,
    clientSecret: payment.clientSecret,
    tripId,
  };
}

const control = (c: Checkout, action: string, body?: unknown) =>
  call("POST", `/v1/fake-provider/payments/${c.paymentRef}/${action}`, {
    headers: { authorization: `Bearer ${c.clientSecret}` },
    ...(body === undefined ? {} : { body }),
  });

/** Run the Worker's cron handler once: the hold, checkout, and email sweeps. */
async function sweep(): Promise<string> {
  const res = await fetch(`${api}/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`);
  await res.text();
  return `scheduled run HTTP ${res.status}`;
}

interface MessageRow {
  id: string;
  template: string;
  state: string;
  attempts: number;
  error: string | null;
  provider_message_id: string | null;
  calls: number;
  accepted: number;
  due: boolean;
}

async function messagesOf(c: Checkout): Promise<MessageRow[]> {
  return sql<MessageRow[]>`
    select m.id, m.template, m.state, m.attempts, m.last_error_code as error,
           m.provider_message_id,
           (select count(*)::int from public.fake_email_deliveries d
             where d.tenant_id = m.tenant_id and d.idempotency_key = m.id::text) as calls,
           (select count(*)::int from public.fake_email_deliveries d
             where d.tenant_id = m.tenant_id and d.idempotency_key = m.id::text
               and d.result = 'accepted') as accepted,
           (m.state = 'queued' and m.next_attempt_at <= now()) as due
      from public.email_messages m
      join public.bookings b on b.tenant_id = m.tenant_id and b.id = m.booking_id
     where b.checkout_session_id = ${c.sessionId}
     order by m.created_at, m.id`;
}

async function snapshot(c: Checkout): Promise<string> {
  const [booking] = await sql<{ n: number; state: string | null }[]>`
    select count(*)::int as n, min(state) as state from public.bookings
     where checkout_session_id = ${c.sessionId}`;
  const shown = (await messagesOf(c)).map((m) =>
    [
      m.template,
      m.state,
      `attempts=${m.attempts}`,
      `error=${m.error ?? "none"}`,
      `provider calls=${m.calls}`,
      `accepted=${m.accepted}`,
    ].join(" "),
  );
  return `bookings=${booking?.n ?? 0}${booking?.state ? ` (${booking.state})` : ""} messages=[${shown.join("; ")}]`;
}

/** Wait, bounded, for the send after a commit: nothing claimed, nothing due. */
async function settle(c: Checkout): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const rows = await messagesOf(c);
    if (rows.length > 0 && rows.every((m) => m.state !== "sending" && !m.due)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function step(c: Checkout, label: string, action: () => Promise<string>): Promise<void> {
  const before = await snapshot(c);
  const result = await action();
  await settle(c);
  const after = await snapshot(c);
  log(`- ${label}`);
  log(`  - result: ${result}`);
  log(`  - before: ${before}`);
  log(`  - after:  ${after}`);
}

const show = (r: { status: number; json: Json }) => {
  const delivery = r.json.delivery as Json | null | undefined;
  if (delivery) {
    return `HTTP ${r.status}; webhook ${delivery.status} ${delivery.outcome} duplicate=${delivery.duplicate}`;
  }
  if (r.json.error) return `HTTP ${r.status} ${(r.json.error as Json).code}`;
  return `HTTP ${r.status}`;
};

async function confirmation(c: Checkout): Promise<MessageRow> {
  const found = (await messagesOf(c)).find((m) => m.template === "booking_confirmation");
  if (!found) throw new Error(`${c.label}: no confirmation message`);
  return found;
}

/** Time passes: the retry falls due now. The trigger lets a time move only earlier. */
async function dueNow(messageId: string): Promise<void> {
  await sql`update public.email_messages set next_attempt_at = now() where id = ${messageId}`;
}

async function main(): Promise<void> {
  log(`Email shim evidence against ${api}, origin ${new URL(origin).hostname}`);
  log(`Run at ${new Date().toISOString()}`);
  const started = new Date();
  const checkouts: Checkout[] = [];

  log("");
  log("1. Sent once after the commit; a replayed payment event and repeated sweeps send nothing");
  const one = await open("delivery", "email.evidence@example.test");
  checkouts.push(one);
  let event = "";
  await step(one, "the guest pays; the fake holds the event back", async () => {
    const r = await control(one, "succeed", { deliver: false });
    event = (r.json.event as { id: string }).id;
    return `${show(r)}; no booking and no message yet`;
  });
  await step(
    one,
    "the fake delivers the event: booking and confirmation commit together, then it is sent",
    async () => show(await control(one, `events/${event}/redeliver`)),
  );
  await step(one, "the fake delivers the same event again (a provider retry)", async () =>
    show(await control(one, `events/${event}/redeliver`)),
  );
  await step(one, "and once more", async () =>
    show(await control(one, `events/${event}/redeliver`)),
  );
  await step(one, "the email sweep runs twice", async () => `${await sweep()}; ${await sweep()}`);

  log("");
  log("2. A temporary failure is retried with the same key once it is due, and sent once");
  const two = await open("retry", "email.retry+fail-once@example.test");
  checkouts.push(two);
  await step(
    two,
    "the guest pays; the send after the commit finds the provider unavailable",
    async () => show(await control(two, "succeed")),
  );
  const retrying = await confirmation(two);
  await step(two, "the sweep runs before the retry is due", sweep);
  await step(two, "time passes; the sweep runs once the retry is due", async () => {
    await dueNow(retrying.id);
    return sweep();
  });
  await step(two, "the sweep runs again", sweep);

  log("");
  log("3. A permanent refusal fails the message, and nothing retries it");
  const three = await open("refusal", "email.refused+bounce@example.test");
  checkouts.push(three);
  await step(three, "the guest pays; the provider refuses the address", async () =>
    show(await control(three, "succeed")),
  );
  await step(three, "the sweep runs twice", async () => `${await sweep()}; ${await sweep()}`);

  log("");
  log("4. A send whose answer was lost is retried with the same key and not sent twice");
  const four = await open("lost answer", "email.lost+fail-once@example.test");
  checkouts.push(four);
  await step(four, "the guest pays; the first send finds the provider unavailable", async () =>
    show(await control(four, "succeed")),
  );
  const lost = await confirmation(four);
  const accepted = `fmsg_${randomBytes(48)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 24)}`;
  await step(
    four,
    "the provider in fact accepted that message, but its answer never came back (filed as the fake would)",
    async () => {
      await sql`
        insert into public.fake_email_deliveries
          (id, tenant_id, idempotency_key, result, from_address, from_name, reply_to,
           to_address, to_name, subject, html_body, text_body)
        select ${accepted}, m.tenant_id, m.id::text, 'accepted', 'bookings@tidegrid.us',
               m.from_name, m.reply_to, m.to_email, m.to_name, m.subject, m.html_body, m.text_body
          from public.email_messages m where m.id = ${lost.id}`;
      return "one accepted delivery on file under the message's key";
    },
  );
  await step(four, "time passes; the sweep retries with the same key", async () => {
    await dueNow(lost.id);
    return sweep();
  });
  const finished = await confirmation(four);
  log(
    `  - the message records the delivery the provider already had: ${
      finished.provider_message_id === accepted ? "yes" : "NO"
    }`,
  );

  log("");
  log("Control total over the messages this run made");
  const sessions = checkouts.map((c) => c.sessionId);
  const [totals] = await sql<
    {
      messages: number;
      sent: number;
      failed: number;
      calls: number;
      accepted: number;
      over: number;
    }[]
  >`
    with mine as (
      select m.* from public.email_messages m
        join public.bookings b on b.tenant_id = m.tenant_id and b.id = m.booking_id
       where b.checkout_session_id = any(${sessions}::uuid[]) and m.created_at >= ${started}
    ), per as (
      select m.id, m.state,
             (select count(*)::int from public.fake_email_deliveries d
               where d.tenant_id = m.tenant_id and d.idempotency_key = m.id::text) as calls,
             (select count(*)::int from public.fake_email_deliveries d
               where d.tenant_id = m.tenant_id and d.idempotency_key = m.id::text
                 and d.result = 'accepted') as accepted
        from mine m
    )
    select count(*)::int as messages,
           count(*) filter (where state = 'sent')::int as sent,
           count(*) filter (where state = 'failed')::int as failed,
           coalesce(sum(calls), 0)::int as calls,
           coalesce(sum(accepted), 0)::int as accepted,
           count(*) filter (where accepted > 1)::int as over
      from per`;
  log(
    `- messages=${totals?.messages} sent=${totals?.sent} failed=${totals?.failed} provider calls=${totals?.calls} accepted deliveries=${totals?.accepted} messages accepted more than once=${totals?.over}`,
  );
}

main()
  .catch((error) => {
    log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
    if (process.env.OUT) writeFileSync(process.env.OUT, `${lines.join("\n")}\n`);
  });
