/**
 * The kill-switch service worker (G2.14b). The guest Worker serves it as
 * /sw.js for a host with a definite miss (no active, verified hostname), and
 * a build with GUEST_SW_KILL_SWITCH=1 ships it to every host as the rollback
 * for a bad service worker: a config revert alone cannot reach a client that
 * already installed one. The browser's update check finds this script, which
 * takes over at once, deletes every cache this origin's workers made, and
 * unregisters itself. It never touches localStorage, sessionStorage, or
 * IndexedDB, where an open checkout and a manage or waiver session live, and
 * it never navigates a page.
 *
 * Plain ES2017 with no imports, so it runs as a classic service worker.
 */
export const killSwitchSource = `"use strict";
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.registration.unregister(); })
  );
});
`;
