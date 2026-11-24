import type { KeyValueStore } from "./sessions.ts";

/**
 * Booking sessions in a browser: the tab's sessionStorage, which the guest
 * web app also uses. It ends with the tab and is never sent anywhere. If the
 * browser refuses storage (a private window, blocked site data), each call
 * rejects and SessionStore keeps the record in memory instead.
 */
export function tabStore(storage: () => Storage = () => globalThis.sessionStorage): KeyValueStore {
  return {
    get: async (key) => storage().getItem(key),
    set: async (key, value) => storage().setItem(key, value),
    remove: async (key) => storage().removeItem(key),
  };
}
