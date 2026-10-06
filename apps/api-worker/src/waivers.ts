import type { TenantTransaction } from "@tidegrid/database";
import {
  bookingParticipantDirectory,
  type WaiverDeps,
  type WaiverMailer,
} from "@tidegrid/domain-waivers";
import type { Context } from "hono";
import { sql } from "kysely";
import type { AppDeps, AppEnv } from "./context.ts";
import type { Bindings } from "./env.ts";

/**
 * What the waiver module (G2.15) needs from the API: the booking's
 * participants, the mailer, and the guest site's origin for links. Tests pass
 * their own through `AppDeps.waiverDeps`.
 */

/** Refuses until transactional email is wired, so nothing records a send that did not happen. */
const unwiredMailer: WaiverMailer = {
  async enqueue() {
    throw new Error("waiver email is not wired to the messaging module yet");
  },
};

/**
 * The guest site's origin for a tenant: GUEST_LINK_ORIGIN with `{slug}`
 * replaced, or https://{slug}.book.tidegrid.us.
 */
export function guestOriginFor(env: Bindings) {
  const template = env.GUEST_LINK_ORIGIN ?? "https://{slug}.book.tidegrid.us";
  return async (trx: TenantTransaction, tenantId: string): Promise<string | null> => {
    const { rows } = await sql<{ slug: string }>`
      select slug from tenants where id = ${tenantId}`.execute(trx);
    const slug = rows[0]?.slug;
    return slug ? template.replace("{slug}", slug) : null;
  };
}

/**
 * A signed waiver's PDF, as recorded. A download, never shown inline, and
 * kept by no cache. The file name carries the booking reference only.
 */
export function pdfResponse(c: Context<AppEnv>, bytes: Uint8Array<ArrayBuffer>, filename: string) {
  return c.body(bytes, 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
}

export function waiverDeps(env: Bindings, deps: AppDeps): WaiverDeps {
  if (deps.waiverDeps) return deps.waiverDeps;
  return {
    participants: bookingParticipantDirectory,
    mailer: unwiredMailer,
    guestOrigin: guestOriginFor(env),
  };
}
