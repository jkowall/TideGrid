/**
 * The API's clock, as the page estimates it. Every deadline on the page (a
 * price's or a hold's expiry, the policy's change deadline) is an instant on
 * the server's clock, but a guest's device clock can be minutes or hours off.
 * Comparing deadlines with `Date.now()` alone would make a fast clock see
 * every new price as expired.
 *
 * The page learns the offset from fresh answers that say when the server made
 * them: a new quote's `quotedAt` or a new checkout's `createdAt`, taken against
 * the moment the answer arrived. A replayed answer is old and teaches nothing.
 * The estimate trails the server by at most the answer's travel time, a few
 * seconds against deadlines of minutes. Until it learns, the device clock
 * stands; the server still decides every deadline.
 */
export class ServerClock {
  #offset = 0;
  #known = false;

  /** Learn from an instant the server just wrote. */
  learn(serverInstant: string, receivedAt: number = Date.now()): void {
    const at = Date.parse(serverInstant);
    if (Number.isNaN(at)) return;
    this.#offset = at - receivedAt;
    this.#known = true;
  }

  /** Take an offset learned earlier, such as one kept through a reload. */
  adopt(offset: number | null): void {
    if (offset === null || !Number.isFinite(offset)) return;
    this.#offset = offset;
    this.#known = true;
  }

  /** The server's time now, or at a given moment on the device's clock. */
  now(local: number = Date.now()): number {
    return local + this.#offset;
  }

  /** The offset in milliseconds (server minus device), or null before the first answer. */
  get offset(): number | null {
    return this.#known ? this.#offset : null;
  }
}
