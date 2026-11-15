import type { EvidenceDocumentStore } from "@tidegrid/domain-waivers";
import type { Bindings } from "./env.ts";
import { ApiError } from "./errors.ts";

/**
 * The evidence bucket (W3-OPS-4): signed waiver PDFs in a private R2 bucket
 * with object lock, under content-addressed keys
 * (`waivers/<tenant>/<sha256>.pdf`). The bucket's lock rule keeps every
 * object for the retention period; this code never deletes or replaces one.
 *
 * Where it applies:
 * - With the `WAIVER_EVIDENCE` binding, every new signature's PDF goes there.
 * - Staging and production without the binding refuse to sign (503
 *   `waiver_storage_unavailable`), so real evidence never lands in the
 *   database by accident.
 * - Local and preview without it keep the PDF in the evidence row, as the
 *   demo always did.
 *
 * Reads go to the bucket only for rows that name a key; older rows keep their
 * bytes in the row and load as before.
 */
export function evidenceStore(env: Bindings): EvidenceDocumentStore | undefined {
  if (env.WAIVER_EVIDENCE) return r2EvidenceStore(env.WAIVER_EVIDENCE);
  if (env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "production") {
    return unavailableStore;
  }
  return undefined;
}

const storageUnavailable = () =>
  new ApiError(
    503,
    "waiver_storage_unavailable",
    "Signed waivers cannot be stored right now; nothing was signed. Try again shortly.",
  );

const unavailableStore: EvidenceDocumentStore = {
  async put() {
    throw storageUnavailable();
  },
  async get() {
    return null;
  },
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export function r2EvidenceStore(bucket: R2Bucket): EvidenceDocumentStore {
  return {
    async put(key, bytes, sha256) {
      let existing: R2Object | null;
      try {
        existing = await bucket.head(key);
      } catch {
        throw storageUnavailable();
      }
      if (existing) {
        // Content-addressed, so an object already there should hold these
        // very bytes (a retried signature). Check rather than trust the name.
        let heldHash: string | null;
        try {
          const held = await bucket.get(key);
          heldHash = held ? await sha256Of(new Uint8Array(await held.arrayBuffer())) : null;
        } catch {
          throw storageUnavailable();
        }
        if (heldHash === sha256) return;
        throw new Error(`evidence object ${key} holds other bytes than its name`);
      }
      try {
        // R2 checks the SHA-256 on arrival and refuses bytes that differ.
        await bucket.put(key, bytes as Uint8Array<ArrayBuffer>, {
          sha256,
          httpMetadata: { contentType: "application/pdf" },
        });
      } catch {
        throw storageUnavailable();
      }
    },
    async get(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  };
}
