/**
 * The waiver link's token and the signing session's secret, in the browser.
 *
 * - The token arrives in the URL's fragment (`/waiver#t=<token>`), which no
 *   server receives. The page takes it once, then removes the fragment from
 *   the address and the tab's history, so it is never bookmarked, shared, or
 *   shown again. It lives in memory until the guest taps to open the waiver.
 * - The session's secret lives in the tab's sessionStorage, so a reload in the
 *   middle of reading does not lose the waiver: a link works once, so without
 *   it a reload would end the guest's session. It is scoped to the tab, sent
 *   only as a bearer header, never in an address, gone when the tab closes,
 *   and cleared when the session ends or has expired. Nothing else about the
 *   waiver is stored.
 */

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const storageKey = "tidegrid.waiver.session";

/** The fragment's token, once: the fragment is removed from the address as it is read. */
export function takeLinkToken(): string | null {
  const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  if (window.location.hash) {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  const token = match?.[1] ?? null;
  return token && tokenPattern.test(token) ? token : null;
}

export interface StoredSession {
  secret: string;
  expiresAt: string;
}

export function loadStoredSession(now = Date.now()): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.secret !== "string" ||
      !tokenPattern.test(parsed.secret) ||
      typeof parsed.expiresAt !== "string" ||
      !(Date.parse(parsed.expiresAt) > now)
    ) {
      clearStoredSession();
      return null;
    }
    return { secret: parsed.secret, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function storeSession(session: StoredSession): void {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(session));
  } catch {
    // Storage blocked: the session still works until the page goes.
  }
}

export function clearStoredSession(): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing stored.
  }
}
