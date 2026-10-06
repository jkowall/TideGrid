/**
 * Whether focus went away with the control the person used: that control left
 * the page, and the browser put focus back on the body. A page that hands
 * focus on after a change does so only then, so it never takes focus from
 * where the person has moved it in the meantime.
 */
export function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}
