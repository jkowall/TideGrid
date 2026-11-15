import { defaultWaiverDeps, type WaiverDeps } from "@tidegrid/domain-waivers";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "./context.ts";
import type { Bindings } from "./env.ts";
import { evidenceStore } from "./evidence-store.ts";
import { fieldKeyring } from "./field-keys.ts";

/**
 * What the waiver module (G2.15) needs from the API: the booking's
 * participants, the evidence bucket for signed PDFs where one applies
 * (W3-OPS-4, src/evidence-store.ts), and the field keyring that seals
 * evidence's personal fields (src/field-keys.ts). Email and its links go through the
 * messaging module, whose delivery job sends what waivers queue. Tests pass
 * their own through `AppDeps.waiverDeps`.
 */
export async function waiverDeps(deps: AppDeps, env: Bindings): Promise<WaiverDeps> {
  if (deps.waiverDeps) return deps.waiverDeps;
  const documents = evidenceStore(env);
  const fields = await fieldKeyring(env);
  return {
    ...defaultWaiverDeps,
    ...(documents ? { documents } : {}),
    ...(fields ? { fields } : {}),
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
