import type { Principal } from "@tidegrid/contracts";
import type { createDb, Database } from "@tidegrid/database";
import type { PaymentProvider } from "@tidegrid/domain-payments";
import type { createLogger } from "@tidegrid/observability";
import type { Kysely } from "kysely";
import type { AccessVerifier } from "./auth/access.ts";
import type { LoginLinkSender } from "./auth/login-links.ts";
import type { Bindings } from "./env.ts";

type Variables = {
  requestId: string;
  log: ReturnType<typeof createLogger>;
  dbHandle?: ReturnType<typeof createDb>;
  principal?: Principal;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

/** Injectable collaborators. Production builds them from bindings; tests pass fakes. */
export interface AppDeps {
  accessVerifier?: AccessVerifier;
  loginLinkSender?: LoginLinkSender;
  /** Wall clock for sales cutoffs and completion checks; tests pin it. */
  now?: () => Date;
  /**
   * Replaces the configured payment provider for checkout and webhooks, so
   * tests can make the provider fail or answer late. The fake provider's demo
   * controls always use the configured fake.
   */
  paymentProvider?: (db: Kysely<Database>, env: Bindings) => PaymentProvider | null;
}
