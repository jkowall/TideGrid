/**
 * Cloudflare Turnstile for the guest site (W3-OPS-4). Where the API checks it,
 * the tenant bootstrap carries a public site key; the page then asks for a
 * token right before the three writes the API guards (opening a checkout,
 * asking for a new waiver link, the dock lookup) and sends it in the
 * `Turnstile-Token` header. The widget runs in managed mode with
 * "interaction-only" appearance: most guests never see it, and a guest
 * Cloudflare wants to check sees a small box at the bottom of the screen.
 *
 * Without a site key (local, preview, tests) nothing loads and every call
 * goes out as before. The script loads once, on first use, never at startup.
 */

export type HumanCheckAction = "checkout" | "waiver_renewal" | "dock_lookup";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "interaction-only";
      execution: "execute";
      callback: (token: string) => void;
      "error-callback": () => void;
      "timeout-callback": () => void;
      "expired-callback": () => void;
    },
  ): string;
  execute(widget: string): void;
  remove(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const tokenTimeoutMs = 60_000;
const scriptTimeoutMs = 15_000;

let siteKey: string | null = null;
let loading: Promise<TurnstileApi> | null = null;

/** Set from the bootstrap: the site key, or null where the API does not check. */
export function setHumanCheck(check: { siteKey: string } | undefined): void {
  siteKey = check?.siteKey ?? null;
}

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      // A failed or stalled load is removed and forgotten, so the next try
      // loads the script afresh instead of waiting on this one.
      const fail = (message: string) => {
        clearTimeout(timer);
        loading = null;
        script.remove();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("turnstile load timed out"), scriptTimeoutMs);
      script.src = SCRIPT;
      script.async = true;
      script.onload = () => {
        if (!window.turnstile) return fail("no turnstile");
        clearTimeout(timer);
        resolve(window.turnstile);
      };
      script.onerror = () => fail("turnstile did not load");
      document.head.append(script);
    });
  }
  return loading;
}

/**
 * A fresh, single-use token for one action. Null when the API does not check
 * (no site key). Throws when the check could not run or did not pass; the
 * caller answers as the API would (403 human_check_failed).
 */
export async function humanToken(action: HumanCheckAction): Promise<string | null> {
  if (!siteKey) return null;
  const turnstile = await loadScript();
  const container = document.createElement("div");
  container.className = "human-check";
  document.body.append(container);
  let widget: string | null = null;
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("turnstile timed out")), tokenTimeoutMs);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("turnstile refused"));
      };
      widget = turnstile.render(container, {
        sitekey: siteKey ?? "",
        action,
        appearance: "interaction-only",
        execution: "execute",
        callback: (token) => {
          clearTimeout(timer);
          resolve(token);
        },
        "error-callback": fail,
        "timeout-callback": fail,
        "expired-callback": fail,
      });
      turnstile.execute(widget);
    });
  } finally {
    if (widget) turnstile.remove(widget);
    container.remove();
  }
}

/** The failure a page shows when the check could not run or did not pass. */
export const humanCheckFailed = {
  kind: "refused",
  status: 403,
  code: "human_check_failed",
} as const;
