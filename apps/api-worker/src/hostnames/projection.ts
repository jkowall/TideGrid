/**
 * A short-lived, size-capped map kept in one isolate's memory: each entry
 * lives at most `ttlMs`, and past `maxEntries` the least recently used goes
 * first. It never leaves the isolate, so it crosses no process, network, or
 * storage boundary and needs no signature (the demo build plan's reading of
 * the target architecture's "signed, short-lived projection"). The CORS
 * projection and the guest host projection both use it.
 */
export class TtlProjection<V> {
  readonly #entries = new Map<string, { value: V; expires: number }>();

  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number,
  ) {}

  get(key: string, now: number): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expires <= now) return undefined;
    // Re-inserted, so iteration order is least recently used first.
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: now + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
