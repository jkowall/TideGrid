interface ConsoleEnv {
  ASSETS: Fetcher;
  API: Fetcher;
}

/**
 * Same-origin API gateway for the console. `/api/v1/...` becomes `/v1/...` on
 * the API Worker. Headers pass through unchanged, including the
 * Cf-Access-Jwt-Assertion that Cloudflare Access adds and the session cookie;
 * the API verifies both itself and trusts nothing this Worker could add.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const target = new URL(request.url);
      target.pathname = url.pathname.slice("/api".length) || "/";
      return env.API.fetch(new Request(target, request));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<ConsoleEnv>;
