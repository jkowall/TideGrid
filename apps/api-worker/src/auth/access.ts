import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Bindings } from "../env.ts";

export interface AccessIdentity {
  email: string;
  subject: string;
}

export interface AccessVerifier {
  /** Resolves to the verified identity, or rejects for any invalid assertion. */
  verify(assertion: string): Promise<AccessIdentity>;
}

const teamDomainPattern = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const audiencePattern = /^[0-9a-f]{64}$/;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Verify a Cloudflare Access application token (the `Cf-Access-Jwt-Assertion`
 * header): RS256 signature against the team's published keys, issuer, this
 * application's audience tag, expiry with sixty seconds of skew, and a usable
 * email. Service tokens carry no email and are rejected.
 */
export function createAccessVerifier(options: {
  teamDomain: string;
  audience: string;
  keys?: JWTVerifyGetKey;
}): AccessVerifier {
  if (!teamDomainPattern.test(options.teamDomain)) throw new Error("invalid Access team domain");
  if (!audiencePattern.test(options.audience)) throw new Error("invalid Access audience tag");
  const issuer = `https://${options.teamDomain}`;
  const keys = options.keys ?? remoteKeySet(issuer);
  return {
    async verify(assertion) {
      const { payload } = await jwtVerify(assertion, keys, {
        issuer,
        audience: options.audience,
        algorithms: ["RS256"],
        clockTolerance: 60,
        requiredClaims: ["exp", "iat", "sub", "email"],
      });
      if (payload.type !== undefined && payload.type !== "app") {
        throw new Error("unexpected Access token type");
      }
      const raw = typeof payload.email === "string" ? payload.email.trim() : "";
      // ASCII before case folding: some non-ASCII characters (the Kelvin sign)
      // lowercase to ASCII letters and would match another person's address.
      if (!/^[\x21-\x7e]+$/.test(raw)) throw new Error("Access email must be ASCII");
      const email = raw.toLowerCase();
      if (email.length > 254 || !emailPattern.test(email)) {
        throw new Error("Access token carries no usable email");
      }
      return { email, subject: String(payload.sub) };
    },
  };
}

// Per-isolate caches: the key set refreshes itself; a forged kid can trigger at
// most one refetch per cooldown.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();
const envVerifiers = new Map<string, AccessVerifier>();

function remoteKeySet(issuer: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cooldownDuration: 60_000,
      cacheMaxAge: 10 * 60_000,
    });
    remoteKeySets.set(issuer, keys);
  }
  return keys;
}

/** The environment's verifier, or null when Access is not configured here. */
export function accessVerifierFromEnv(env: Bindings): AccessVerifier | null {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) return null;
  const cacheKey = `${teamDomain}|${audience}`;
  let verifier = envVerifiers.get(cacheKey);
  if (!verifier) {
    verifier = createAccessVerifier({ teamDomain, audience });
    envVerifiers.set(cacheKey, verifier);
  }
  return verifier;
}
