/**
 * Owner addresses supplied at seed time, so personal addresses never enter the
 * repository.
 *
 *   SEED_OWNER_EMAILS=a@x,b@y         owners of both demo operators
 *   SEED_SINGLE_TENANT_OWNER=c@z:slug an owner of one operator only, so a
 *                                     signed-in operator can be shown unable
 *                                     to reach the other (acceptance step 7)
 *   SEED_OWNER_DISPLAY_NAME=Name      the display name for new rows of these
 *                                     addresses, instead of the address's
 *                                     local part, so no address reaches the
 *                                     console or its screenshots
 *
 * The seed never removes a membership, so the single-tenant address may not
 * also be in SEED_OWNER_EMAILS: one run would make it an owner of both, and
 * only an admin delete could undo that. Existing rows keep their names.
 */

export interface SeedOwner {
  email: string;
  name: string;
  /** Indexes into the demo tenants. */
  tenants: number[];
}

const emailPattern = /^[^@\s:,]+@[^@\s:,]+\.[^@\s:,]+$/;
// C0 and C1 controls, which the database's checks also refuse.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const namePattern = /^[^\u0000-\u001f\u007f-\u009f@]{1,120}$/;

export class SeedOwnerError extends Error {}

export function parseSeedOwners(
  env: Record<string, string | undefined>,
  tenantSlugs: readonly string[],
): SeedOwner[] {
  const shared = (env.SEED_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  for (const email of shared) {
    if (!emailPattern.test(email)) {
      throw new SeedOwnerError("SEED_OWNER_EMAILS contains an invalid address.");
    }
  }

  const rawName = env.SEED_OWNER_DISPLAY_NAME;
  let displayName: string | null = null;
  if (rawName !== undefined && rawName !== "") {
    const trimmed = rawName.trim();
    if (!namePattern.test(trimmed) || trimmed !== rawName) {
      throw new SeedOwnerError(
        "SEED_OWNER_DISPLAY_NAME must be 1 to 120 characters, with no address, no control characters, and no surrounding spaces.",
      );
    }
    displayName = trimmed;
  }
  const nameFor = (email: string) => displayName ?? email.split("@")[0] ?? "Owner";

  const owners: SeedOwner[] = shared.map((email) => ({
    email,
    name: nameFor(email),
    tenants: tenantSlugs.map((_, i) => i),
  }));

  const single = env.SEED_SINGLE_TENANT_OWNER?.trim();
  if (single) {
    const at = single.lastIndexOf(":");
    const email = (at > 0 ? single.slice(0, at) : "").toLowerCase();
    const slug = at > 0 ? single.slice(at + 1) : "";
    if (!emailPattern.test(email)) {
      throw new SeedOwnerError("SEED_SINGLE_TENANT_OWNER must be <address>:<tenant slug>.");
    }
    const index = tenantSlugs.indexOf(slug);
    if (index < 0) {
      throw new SeedOwnerError(
        `SEED_SINGLE_TENANT_OWNER names an unknown tenant; use one of ${tenantSlugs.join(", ")}.`,
      );
    }
    if (shared.includes(email)) {
      throw new SeedOwnerError(
        "SEED_SINGLE_TENANT_OWNER is also in SEED_OWNER_EMAILS. The seed never removes a membership, so that address would own both operators for good.",
      );
    }
    owners.push({ email, name: nameFor(email), tenants: [index] });
  }
  return owners;
}
