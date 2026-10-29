/**
 * nov1 payment-account set <slug> stripe (P9, gate A12). An admin-connection
 * insert into payment_accounts (0007_checkout_and_confirmation.sql:73-82): a
 * checkout needs an active row at its provider (0007:900-906), and the seed
 * writes only fake rows. The account id comes from STRIPE_ACCT_<SLUG> in the
 * owner's shell, is never printed or journaled unredacted, and never enters git.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, out, type Plan, printPlan, Refusal } from "../core.ts";
import { assertNoDbHazard } from "../env.ts";
import { classifyUrl, displayHost, liveGate } from "../gate.ts";
import { record } from "../journal.ts";

export const accountEnvName = (slug: string) =>
  `STRIPE_ACCT_${slug.toUpperCase().replaceAll("-", "_")}`;

/** A Stripe connected account id: acct_ and 1 to 64 safe characters, never the fake's. */
export function checkAccountRef(ref: string | undefined, name: string): string {
  if (!ref) throw new Refusal(`${name} is not set in this shell`);
  if (!/^acct_[A-Za-z0-9]{1,64}$/.test(ref))
    throw new Refusal(`${name} is not a Stripe account id (acct_...)`);
  if (ref.startsWith("acct_fake")) throw new Refusal(`${name} is a fake provider reference`);
  return ref;
}

export const paymentAccountSql = {
  tenant: "select id::text from public.tenants where slug = $1",
  context:
    "select set_config('app.tenant_id', $1, true), set_config('app.actor_type', 'support', true), set_config('app.actor_id', 'nov1:A12', true)",
  existing:
    "select account_ref, status from public.payment_accounts where tenant_id = $1::uuid and provider = 'stripe'",
  insert:
    "insert into public.payment_accounts (tenant_id, provider, account_ref, status) values ($1::uuid, 'stripe', $2, 'active')",
};

export function paymentAccountPlan(slug: string): Plan {
  return {
    command: `payment-account set ${slug} stripe`,
    target: "the database in $NEON_DATABASE_URL",
    steps: [
      {
        id: "P9.1",
        title: `An active stripe payment account for ${slug}`,
        gate: "A12",
        commands: [paymentAccountSql.context, paymentAccountSql.insert],
        envNames: ["NEON_DATABASE_URL", accountEnvName(slug)],
        expect: ["created, or unchanged when the same id is already there"],
        rollback: [
          "leave the row: Stripe stays unused while PAYMENT_PROVIDER is fake. The runtime has no DELETE",
        ],
      },
    ],
  };
}

export async function paymentAccount(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["url-env", "live", "go"]);
  const [verb, slug, provider] = args.positional;
  if (verb !== "set" || provider !== "stripe")
    throw new Refusal("nov1 payment-account set <slug> stripe");
  if (slug !== "demo-harbor" && slug !== "demo-reef")
    throw new Refusal("slug is demo-harbor or demo-reef");
  assertNoDbHazard(deps, { allowDemoBookings: false });
  const urlEnv = flag(args, "url-env") ?? "NEON_DATABASE_URL";
  const url = deps.env[urlEnv];
  if (!url) throw new Refusal(`${urlEnv} is not set in this shell`);
  const live = classifyUrl(url) === "live";
  if (live && !args.flags.has("live")) {
    printPlan(deps, paymentAccountPlan(slug));
    return 0;
  }
  const name = accountEnvName(slug);
  const ref = checkAccountRef(deps.env[name], name);
  if (live) {
    await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      {
        gates: ["A12"],
        confirm: [displayHost(url), slug],
        action: `insert ${slug}'s stripe payment account from ${name}`,
      },
    );
  }
  const sql = deps.sql(url);
  try {
    const outcome = await sql.transaction(async (tx) => {
      const [tenant] = await tx.query<{ id: string }>(paymentAccountSql.tenant, [slug]);
      if (!tenant) throw new Refusal(`no tenant ${slug}`);
      await tx.query(paymentAccountSql.context, [tenant.id]);
      const [existing] = await tx.query<{ account_ref: string; status: string }>(
        paymentAccountSql.existing,
        [tenant.id],
      );
      if (existing) {
        if (existing.account_ref === ref && existing.status === "active") return "unchanged";
        throw new Refusal(
          `${slug} already has a different or disabled stripe account; nothing written`,
        );
      }
      await tx.query(paymentAccountSql.insert, [tenant.id, ref]);
      return "created";
    });
    out(deps, `${slug} stripe account (${name}): ${outcome}`);
    if (live)
      record(deps, {
        phase: "p9",
        step: "payment-account",
        gate: "A12",
        result: "done",
        note: `${slug} ${outcome}`,
      });
    return 0;
  } finally {
    await sql.end();
  }
}
