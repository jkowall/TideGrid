/**
 * Secret values from a file (owner decision 2026-11-05, item 3): allowed for
 * test-mode values only, from a 0600 file outside the repository, removed
 * after use. Live-mode keys always go through the owner at wrangler's prompt.
 *
 * Only two names qualify:
 * - STRIPE_SECRET_KEY: an sk_test_ or rk_test_ key. Any live key is refused.
 * - STRIPE_WEBHOOK_SECRET: a whsec_ value says nothing about its endpoint's
 *   mode, and nov1 makes no live call to ask. The owner chose the pairing
 *   rule: the shell's STRIPE_SECRET_KEY is a test key, and the journal shows
 *   the API's STRIPE_SECRET_KEY last put from a test-mode file in this phase.
 *   That is an inference (the endpoint was made with that key), not a proof.
 *
 * Everything else (the email allowlist, the Cloudflare token, the fake's
 * webhook secret, which --generate covers) is typed by the owner.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { type Deps, Refusal } from "./core.ts";
import type { Entry, Journal } from "./journal.ts";
import type { Phase } from "./phase.ts";

export const fileSecrets = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;

/** For the shell's key, which is already a string. File values are checked as bytes. */
const testKeyText = /^(sk|rk)_test_[A-Za-z0-9]{8,}$/;

const isAlnum = (b: number) =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

function hasPrefix(buf: Uint8Array, prefix: string): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix.charCodeAt(i)) return false;
  return true;
}

/**
 * One of the prefixes, then at least minRest characters of [A-Za-z0-9].
 * Checked on the bytes, so the value never becomes a string nov1 cannot zero.
 */
function shaped(buf: Uint8Array, prefixes: readonly string[], minRest: number): boolean {
  const prefix = prefixes.find((p) => hasPrefix(buf, p));
  if (!prefix || buf.length < prefix.length + minRest) return false;
  for (let i = prefix.length; i < buf.length; i++) if (!isAlnum(buf[i] as number)) return false;
  return true;
}

/** Refuse a name that may not come from a file, before the gate runs. */
export function assertFileName(name: string): void {
  if (!(fileSecrets as readonly string[]).includes(name)) {
    throw new Refusal(
      `${name} is typed by the owner at wrangler's prompt; --from-file takes only Stripe test-mode values (${fileSecrets.join(", ")})`,
    );
  }
}

function checkFile(st: Stats): void {
  if (!st.isFile()) throw new Refusal("--from-file is not a regular file");
  // A second name for the file could sit inside a repository and outlive the removal.
  if (st.nlink !== 1) throw new Refusal("--from-file has more than one link (a hard link)");
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid)
    throw new Refusal("--from-file is owned by another user");
  if ((st.mode & 0o777) !== 0o600) {
    throw new Refusal(
      `--from-file must be mode 0600 (it is 0${(st.mode & 0o777).toString(8)}); nothing ran`,
    );
  }
}

/** True when the path, or any directory above it, holds a .git: any checkout or worktree. */
function inGitWorkTree(real: string): boolean {
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The checked file, so cleanup removes that file and nothing swapped in at its path. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

/** Read the file once, check where it lives and who can read it, and return its one line. */
function readPrivateLine(deps: Deps, path: string): { line: Buffer; identity: FileIdentity } {
  if (!isAbsolute(path)) throw new Refusal("--from-file needs an absolute path");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new Refusal("--from-file: cannot read that file");
  }
  if (st.isSymbolicLink()) throw new Refusal("--from-file is a symlink; name the file itself");
  checkFile(st);
  const real = realpathSync(path);
  const root = realpathSync(deps.repoRoot);
  if (real === root || real.startsWith(`${root}${sep}`)) {
    throw new Refusal("--from-file must be outside the repository");
  }
  if (inGitWorkTree(real)) {
    throw new Refusal("--from-file must be outside the repository and any git work tree");
  }
  // O_NOFOLLOW and the same checks on the open descriptor: the file read is
  // the file checked, even if the path was swapped in between.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Refusal("--from-file changed while it was checked; nothing ran");
  }
  try {
    const fst = fstatSync(fd);
    if (fst.ino !== st.ino || fst.dev !== st.dev)
      throw new Refusal("--from-file changed while it was checked; nothing ran");
    checkFile(fst);
    if (fst.size > 4096) throw new Refusal("--from-file is too large for one secret");
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    try {
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, off);
        if (n === 0) break;
        off += n;
      }
    } catch {
      buf.fill(0);
      throw new Refusal("--from-file: cannot read that file");
    }
    let end = off;
    if (end > 0 && buf[end - 1] === 0x0a) end--;
    if (end > 0 && buf[end - 1] === 0x0d) end--;
    const line = buf.subarray(0, end);
    if (line.includes(0x0a) || line.includes(0x0d)) {
      buf.fill(0);
      throw new Refusal("--from-file must hold one line: the secret alone");
    }
    return { line, identity: { dev: fst.dev, ino: fst.ino } };
  } finally {
    closeSync(fd);
  }
}

const touchesKey = (e: Entry) =>
  (e.worker === undefined || e.worker === "api") &&
  (e.secret === "STRIPE_SECRET_KEY" || (e.note ?? "").startsWith("STRIPE_SECRET_KEY;"));

/**
 * The pairing rule for a webhook secret: the API's STRIPE_SECRET_KEY was put
 * from a test-mode file in this phase, and nothing journaled since could have
 * changed it: no later put or delete of the key in any result (started,
 * failed, or done), and no rollback of the API, which can bring back an older
 * key. A put is journaled as started before wrangler runs, so an interrupted
 * one still breaks the pairing.
 */
function assertPairedKey(journal: Journal, phase: Phase): void {
  const entries = journal.entries;
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Entry;
    if (
      e.step === "secret-put" &&
      e.result === "done" &&
      e.source === "test-file" &&
      touchesKey(e)
    ) {
      at = i;
      break;
    }
  }
  const anchor = entries[at];
  if (!anchor) {
    throw new Refusal(
      "the journal shows no STRIPE_SECRET_KEY put on the API from a test-file; put the test key with --from-file first, or the owner types the webhook secret",
    );
  }
  const since = entries
    .slice(at + 1)
    .find((e) => touchesKey(e) || (e.step === "rollback" && e.worker === "api"));
  if (since) {
    throw new Refusal(
      `the API's STRIPE_SECRET_KEY may have changed since its test-file put (${since.step}, ${since.result}); put the test key again from a file first`,
    );
  }
  if (anchor.phase !== phase) {
    throw new Refusal(
      `the API's STRIPE_SECRET_KEY was put in ${anchor.phase.toUpperCase()}, not ${phase.toUpperCase()}; put the test key again in this phase first`,
    );
  }
}

/**
 * Remove the file only if the path still names the file that was checked
 * and read: a regular file, not a symlink, same device and inode. Anything
 * else is left in place ("other"). A hard link made since the read keeps the
 * secret at a name nov1 does not know: this name is removed, but the result
 * is "linked", never "removed".
 */
export function removeCheckedFile(
  path: string,
  identity: FileIdentity,
): "removed" | "linked" | "other" {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.dev !== identity.dev || st.ino !== identity.ino) return "other";
    unlinkSync(path);
    return st.nlink === 1 ? "removed" : "linked";
  } catch {
    return "other";
  }
}

/**
 * The test-mode value for `name` from `path`, or a Refusal. The caller sends
 * it to wrangler's stdin and zeroes the buffer. Nothing here prints the value
 * or turns it into a string.
 */
export function readTestSecret(
  deps: Deps,
  name: string,
  path: string,
  journal: Journal,
  phase: Phase,
): { value: Buffer; identity: FileIdentity } {
  assertFileName(name);
  if (name === "STRIPE_WEBHOOK_SECRET") {
    // Checked before the file is read: a refusal here never touches the value.
    if (!testKeyText.test(deps.env.STRIPE_SECRET_KEY ?? "")) {
      throw new Refusal(
        "the shell's STRIPE_SECRET_KEY is not a test key (sk_test_ or rk_test_): a webhook secret comes from a file only when paired with the test key that made its endpoint",
      );
    }
    assertPairedKey(journal, phase);
  }
  const { line: value, identity } = readPrivateLine(deps, path);
  const refuse = (why: string): never => {
    value.fill(0);
    throw new Refusal(why);
  };
  if (name === "STRIPE_SECRET_KEY") {
    if (hasPrefix(value, "sk_live_") || hasPrefix(value, "rk_live_"))
      refuse("a live-mode key always goes through the owner, typed at wrangler's prompt");
    if (!shaped(value, ["sk_test_", "rk_test_"], 8))
      refuse("STRIPE_SECRET_KEY from a file must be a Stripe test-mode key (sk_test_ or rk_test_)");
  } else if (!shaped(value, ["whsec_"], 24)) {
    refuse("STRIPE_WEBHOOK_SECRET from a file must be a webhook signing secret (whsec_...)");
  }
  return { value, identity };
}
