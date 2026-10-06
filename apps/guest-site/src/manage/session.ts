/**
 * Where the management page keeps its booking session, and how it takes a
 * link's token from the address (lane 1, G2.11c).
 *
 * - The link's token arrives in the URL's fragment, `#t=<token>`, which the
 *   browser never sends to a server. The page reads it, takes it out of the
 *   address and the tab's history at once, and keeps it only in memory until
 *   the guest asks to open the booking.
 * - The session's token, which the API returns once, lives in sessionStorage
 *   for this tab only, so a reload keeps the guest in, and goes when the tab
 *   closes, the session ends, or the API says it has. Never in a URL, a log,
 *   or storage that outlives the tab. One record: opening another booking in
 *   the tab replaces it.
 */

const KEY = "tidegrid.manage.v1";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface StoredSession {
  token: string;
  expiresAt: string;
  reference: string;
  /**
   * The link this session was opened with. Used already, so it opens
   * nothing; it can only ask for a new link to the booker's own address.
   */
  linkToken?: string;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The tab's session, unless it has expired by the device's clock or is unreadable. */
export function loadSession(now: number = Date.now()): StoredSession | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof value.token === "string" &&
      tokenPattern.test(value.token) &&
      typeof value.expiresAt === "string" &&
      typeof value.reference === "string" &&
      Date.parse(value.expiresAt) > now
    ) {
      return {
        token: value.token,
        expiresAt: value.expiresAt,
        reference: value.reference,
        ...(typeof value.linkToken === "string" && tokenPattern.test(value.linkToken)
          ? { linkToken: value.linkToken }
          : {}),
      };
    }
  } catch {
    // Unreadable: drop it below.
  }
  clearSession();
  return null;
}

export function storeSession(session: StoredSession): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage full or blocked: the session still works until this page goes.
  }
}

export function clearSession(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The link's token in the address, if there is a well-formed one. Pure: changes nothing. */
export function readLinkToken(hash: string = window.location.hash): string | null {
  const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(hash);
  return match?.[1] ?? null;
}

/**
 * Take the fragment out of the address and this history entry, so the token
 * is not left in the tab's history, a bookmark, or a screenshot of the
 * address bar. Idempotent.
 */
export function forgetLinkToken(): void {
  if (!window.location.hash) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}
