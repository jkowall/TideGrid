/**
 * Where the app keeps its booking sessions. The guest web app keeps one
 * session per tab in sessionStorage: its token, when it expires, and the
 * booking's reference (apps/guest-site src/manage/session.ts). The app keeps
 * the same three fields, one record per booking, in the platform's secure
 * storage (Keychain on iOS, Keystore-backed storage on Android, through
 * expo-secure-store). Nothing else is stored: no checkout secret, payment
 * secret, link token, name, or email. A session lasts an hour, as the API
 * sets it; an expired record is dropped on the next read.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StoredSession {
  token: string;
  expiresAt: string;
  reference: string;
}

/** The most bookings kept; the oldest goes first. Keeps the record small for secure storage. */
export const maxSessions = 10;

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const referencePattern = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** One key per operator, so two demo builds on one phone never share a record. */
export const storageKey = (slug: string) => `tidegrid.manage.v1.${slug}`;

function valid(value: unknown, now: number): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<StoredSession>;
  return (
    typeof v.token === "string" &&
    tokenPattern.test(v.token) &&
    typeof v.reference === "string" &&
    referencePattern.test(v.reference) &&
    typeof v.expiresAt === "string" &&
    Date.parse(v.expiresAt) > now
  );
}

export class SessionStore {
  /** Every read and write in order, so a removal never overwrites a booking just added. */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * What the app last knew, kept while it runs: if secure storage fails, a
   * booking just opened (its link already used) still shows until the app closes.
   */
  #memory: StoredSession[] = [];

  constructor(
    private readonly store: KeyValueStore,
    private readonly slug: string,
  ) {}

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The sessions still in date, newest first. Never throws. */
  list(now: number = Date.now()): Promise<StoredSession[]> {
    return this.#serial(() => this.#list(now));
  }

  /** Keep a session, replacing any older one for the same booking. */
  add(session: StoredSession, now: number = Date.now()): Promise<void> {
    return this.#serial(async () => {
      if (!valid(session, now)) return;
      const others = (await this.#list(now)).filter((s) => s.reference !== session.reference);
      const { token, expiresAt, reference } = session;
      await this.#write([{ token, expiresAt, reference }, ...others].slice(0, maxSessions));
    });
  }

  /** Forget one booking's session, as when the API says it ended. */
  remove(reference: string, now: number = Date.now()): Promise<void> {
    return this.#serial(async () => {
      const list = await this.#list(now);
      const kept = list.filter((s) => s.reference !== reference);
      if (kept.length !== list.length) await this.#write(kept);
    });
  }

  clear(): Promise<void> {
    return this.#serial(() => this.#write([]));
  }

  async #list(now: number): Promise<StoredSession[]> {
    const fresh = (list: StoredSession[]) => list.filter((v) => valid(v, now));
    let raw: string | null;
    try {
      raw = await this.store.get(storageKey(this.slug));
    } catch {
      this.#memory = fresh(this.#memory);
      return this.#memory;
    }
    if (!raw) {
      // Nothing stored: what memory holds is only what a failed write left.
      this.#memory = fresh(this.#memory);
      return this.#memory;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.#write([]);
      return [];
    }
    const all = Array.isArray(parsed) ? parsed : [];
    const kept = all
      .filter((v): v is StoredSession => valid(v, now))
      .map(({ token, expiresAt, reference }) => ({ token, expiresAt, reference }));
    if (kept.length !== all.length) await this.#write(kept);
    this.#memory = kept;
    return kept;
  }

  async #write(list: StoredSession[]): Promise<void> {
    this.#memory = list;
    try {
      if (list.length === 0) await this.store.remove(storageKey(this.slug));
      else await this.store.set(storageKey(this.slug), JSON.stringify(list));
    } catch {
      // Storage blocked: the memory copy keeps the session while the app is open.
    }
  }
}
