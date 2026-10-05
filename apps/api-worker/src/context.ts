import type { Principal } from "@tidegrid/contracts";
import type { createDb } from "@tidegrid/database";
import type { createLogger } from "@tidegrid/observability";
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
}
