/**
 * Security headers for every response the guest Worker writes itself (G2.14b).
 * public/_headers applies only to static asset responses, so the manifest,
 * the icons, the kill switch, and every 404 and 503 set theirs here. None of
 * these responses is a page, so each gets a policy that loads nothing.
 */
const common: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** Nothing loads: for JSON, scripts, and plain-text errors. */
export const NOTHING_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Icons can be opened as top-level documents, and brand assets are served
 * under a strict policy (the target architecture): no script, no fetch, and
 * no external image, only the SVG's own inline presentation.
 */
export const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export function securityHeaders(
  contentType: string,
  cacheControl: string,
  csp: string = NOTHING_CSP,
): Headers {
  const headers = new Headers(common);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", cacheControl);
  headers.set("Content-Security-Policy", csp);
  return headers;
}

/** A plain-text answer for the Worker's own paths: 404 for a definite miss, 503 otherwise. */
export function plain(status: 404 | 503, body: string): Response {
  return new Response(body, {
    status,
    headers: securityHeaders("text/plain; charset=utf-8", "no-store"),
  });
}
