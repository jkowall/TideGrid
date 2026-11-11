/**
 * Where the participant page keeps its session (W3-G2.11-rest), the same way
 * the booking's management page keeps its own.
 *
 * - The invitation's token arrives in the URL's fragment, `#t=<token>`, which
 *   no server receives. The page reads it, takes it out of the address and
 *   the tab's history at once, and keeps it in memory until the person taps
 *   to open their details.
 * - The session's token lives in this tab's sessionStorage, so a reload keeps
 *   the person in. It goes when the tab closes, the session ends, or the API
 *   says it has. Never in a URL or storage that outlives the tab.
 */

const KEY = "tidegrid.participant.v1";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface StoredSession {
  token: string;
  expiresAt: string;
}

/** The fragment's token, once: the fragment is removed from the address as it is read. */
export function takeLinkToken(): string | null {
  const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  if (window.location.hash) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return match?.[1] ?? null;
}

/** Whether this tab holds a session record at all, live or run out. Reads only. */
export function hadSession(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function loadSession(now: number = Date.now()): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof value.token === "string" &&
      tokenPattern.test(value.token) &&
      typeof value.expiresAt === "string" &&
      Date.parse(value.expiresAt) > now
    ) {
      return { token: value.token, expiresAt: value.expiresAt };
    }
    clearSession();
    return null;
  } catch {
    clearSession();
    return null;
  }
}

export function storeSession(session: StoredSession): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage blocked: the session still works until the page goes.
  }
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
