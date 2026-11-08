import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectionHosts,
  integrationAdminUrl,
  isNeonHost,
  type NeonGuardSource,
  neonMainRefusal,
  prepareIntegrationDatabase,
  recordedNeonMainHost,
} from "./testing.ts";

describe("isNeonHost", () => {
  it("is true for Neon endpoints, direct and pooled", () => {
    expect(isNeonHost("postgresql://o:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb")).toBe(
      true,
    );
    expect(
      isNeonHost("postgresql://o:p@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require"),
    ).toBe(true);
  });

  it("is false for the local container and look-alike hosts", () => {
    expect(isNeonHost("postgresql://postgres:postgres@127.0.0.1:55432/tidegrid")).toBe(false);
    expect(isNeonHost("postgresql://postgres:postgres@localhost:5432/tidegrid")).toBe(false);
    expect(isNeonHost("postgresql://o:p@neon.tech.example.com/db")).toBe(false);
    expect(isNeonHost("postgresql://o:p@notneon.tech/db")).toBe(false);
  });
});

describe("integrationAdminUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails rather than skips in CI when DATABASE_URL is unset", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => integrationAdminUrl()).toThrow(/DATABASE_URL is required in CI/);
  });

  it("skips outside CI when DATABASE_URL is unset", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(integrationAdminUrl()).toBeNull();
  });

  it("refuses a database not marked as throwaway", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55432/tidegrid");
    vi.stubEnv("TIDEGRID_EPHEMERAL_DB", "");
    expect(() => integrationAdminUrl()).toThrow(/TIDEGRID_EPHEMERAL_DB=1/);
  });
});

// Synthetic hosts only. None is a real endpoint.
const mainHost = "ep-main-000000.us-east-2.aws.neon.tech";
const branchHost = "ep-branch-111111.us-east-2.aws.neon.tech";
const local = "postgresql://postgres:postgres@127.0.0.1:55432/tidegrid";
const onMain = `postgresql://owner:pw-not-real@${mainHost}/neondb?sslmode=require`;
const onMainPooled = `postgresql://owner:pw-not-real@ep-main-000000-pooler.us-east-2.aws.neon.tech/neondb`;
const onBranch = `postgresql://owner:pw-not-real@${branchHost}/neondb?sslmode=require`;

function source(env: Record<string, string> = {}, envLocal: string | null = null): NeonGuardSource {
  return { env, readEnvLocal: () => envLocal };
}

/** A refusal must never carry a host, a user, or a password. */
function expectNoEcho(message: string | null) {
  expect(message).not.toBeNull();
  for (const part of [
    mainHost,
    branchHost,
    "ep-main",
    "ep-branch",
    "pw-not-real",
    "owner",
    "127.0.0.1",
  ]) {
    expect(message).not.toContain(part);
  }
}

describe("recordedNeonMainHost", () => {
  it("is missing when unset or blank in both places", () => {
    expect(recordedNeonMainHost(source())).toEqual({ kind: "missing" });
    expect(recordedNeonMainHost(source({ NEON_MAIN_HOST: "  " }, "NEON_MAIN_HOST=\n"))).toEqual({
      kind: "missing",
    });
    expect(recordedNeonMainHost(source({}, "OTHER=1\n"))).toEqual({ kind: "missing" });
  });

  it("reads the environment and .env.local, normalized", () => {
    expect(recordedNeonMainHost(source({ NEON_MAIN_HOST: mainHost.toUpperCase() }))).toEqual({
      kind: "set",
      hosts: [mainHost],
    });
    expect(recordedNeonMainHost(source({}, `# local\nNEON_MAIN_HOST="${mainHost}."\n`))).toEqual({
      kind: "set",
      hosts: [mainHost],
    });
    expect(
      recordedNeonMainHost(
        source({ NEON_MAIN_HOST: "db.example.test" }, `NEON_MAIN_HOST=${mainHost}`),
      ),
    ).toEqual({ kind: "set", hosts: ["db.example.test", mainHost] });
  });

  it("treats anything but a bare host name as malformed", () => {
    for (const bad of [
      onMain,
      `${mainHost}:5432`,
      `owner@${mainHost}`,
      `${mainHost}/neondb`,
      "two words",
      "-leading-dash.neon.tech",
      `${mainHost},${branchHost}`,
    ]) {
      expect(recordedNeonMainHost(source({ NEON_MAIN_HOST: bad }))).toEqual({
        kind: "malformed",
        where: "the environment",
      });
    }
    expect(recordedNeonMainHost(source({}, `NEON_MAIN_HOST=${onMain}`))).toEqual({
      kind: "malformed",
      where: ".env.local",
    });
  });
});

describe("connectionHosts", () => {
  it("returns the host a client would reach, folding a pooled endpoint", () => {
    expect(connectionHosts(local, {})).toEqual(["127.0.0.1"]);
    expect(connectionHosts(onMainPooled, {})).toEqual([mainHost]);
    expect(connectionHosts(`postgresql://o:p@${mainHost.toUpperCase()}./db`, {})).toEqual([
      mainHost,
    ]);
  });

  it("lists every host of a multi-host URL", () => {
    expect(connectionHosts(`postgresql://o:p@127.0.0.1:5432,${mainHost}:5432/db`, {})).toEqual([
      "127.0.0.1",
      mainHost,
    ]);
  });

  it("falls back to PGHOST, then localhost, as postgres.js does", () => {
    expect(connectionHosts("postgresql:///db", { PGHOST: mainHost })).toEqual([mainHost]);
    expect(connectionHosts("postgresql:///db", {})).toEqual(["localhost"]);
  });

  it("is null for a malformed URL", () => {
    for (const bad of [
      "not a url",
      "postgresql://o:p@host:99999/db",
      "postgresql://o:p@a,,b/db",
      "",
    ]) {
      expect(connectionHosts(bad, {})).toBeNull();
    }
  });
});

describe("neonMainRefusal for integration suites", () => {
  const ephemeral = { TIDEGRID_EPHEMERAL_DB: "1" };

  it("refuses the recorded main host, direct or pooled, from either place", () => {
    for (const s of [
      source({ ...ephemeral, NEON_MAIN_HOST: mainHost }),
      source(ephemeral, `NEON_MAIN_HOST=${mainHost}\n`),
      source({ ...ephemeral, TIDEGRID_NEON_BRANCH: "1", NEON_MAIN_HOST: mainHost }),
    ]) {
      for (const url of [onMain, onMainPooled]) {
        const refusal = neonMainRefusal(url, "tests", s);
        expect(refusal).toMatch(/recorded in NEON_MAIN_HOST/);
        expect(refusal).toMatch(/rule 4/);
        expectNoEcho(refusal);
      }
    }
  });

  it("allows a different host once main is recorded", () => {
    const s = source({ ...ephemeral, NEON_MAIN_HOST: mainHost });
    expect(neonMainRefusal(onBranch, "tests", s)).toBeNull();
    expect(neonMainRefusal(local, "tests", s)).toBeNull();
  });

  it("with main missing, refuses any Neon host unless it is marked as a throwaway branch", () => {
    const refusal = neonMainRefusal(onBranch, "tests", source(ephemeral));
    expect(refusal).toMatch(/TIDEGRID_NEON_BRANCH=1/);
    expect(refusal).toMatch(/NEON_MAIN_HOST is not recorded/);
    expectNoEcho(refusal);
    expect(
      neonMainRefusal(onBranch, "tests", source({ ...ephemeral, TIDEGRID_NEON_BRANCH: "true" })),
    ).not.toBeNull();
    expect(
      neonMainRefusal(onBranch, "tests", source({ ...ephemeral, TIDEGRID_NEON_BRANCH: "1" })),
    ).toBeNull();
    expect(neonMainRefusal(local, "tests", source(ephemeral))).toBeNull();
  });

  it("refuses a malformed recorded host, even for the local container", () => {
    const refusal = neonMainRefusal(local, "tests", source({ NEON_MAIN_HOST: onMain }));
    expect(refusal).toMatch(/NEON_MAIN_HOST in the environment is not a bare host name/);
    expectNoEcho(refusal);
  });

  it("refuses a malformed DATABASE_URL without echoing it", () => {
    const refusal = neonMainRefusal(
      `postgresql://owner:pw-not-real@${mainHost}:99999/neondb`,
      "tests",
      source({ NEON_MAIN_HOST: mainHost }),
    );
    expect(refusal).toMatch(/not a valid connection URL/);
    expectNoEcho(refusal);
  });

  it("refuses an unreadable .env.local", () => {
    const refusal = neonMainRefusal(local, "tests", {
      env: {},
      readEnvLocal: () => {
        throw new Error("Refused: the repository root .env.local exists but could not be read.");
      },
    });
    expect(refusal).toMatch(/could not be read/);
  });
});

describe("integrationAdminUrl and global setup refuse Neon main", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses the recorded main host even with TIDEGRID_EPHEMERAL_DB=1", () => {
    vi.stubEnv("DATABASE_URL", onMain);
    vi.stubEnv("TIDEGRID_EPHEMERAL_DB", "1");
    expect(() => integrationAdminUrl(source({ NEON_MAIN_HOST: mainHost }))).toThrow(
      /recorded in NEON_MAIN_HOST/,
    );
    expect(() => integrationAdminUrl(source({}))).toThrow(/TIDEGRID_NEON_BRANCH=1/);
  });

  it("still returns the local container's URL", () => {
    vi.stubEnv("DATABASE_URL", local);
    vi.stubEnv("TIDEGRID_EPHEMERAL_DB", "1");
    expect(integrationAdminUrl(source({ NEON_MAIN_HOST: mainHost }))).toBe(local);
    expect(integrationAdminUrl(source({}))).toBe(local);
  });

  it("global setup refuses before it migrates or provides anything", async () => {
    vi.stubEnv("DATABASE_URL", onMain);
    vi.stubEnv("TIDEGRID_EPHEMERAL_DB", "1");
    vi.stubEnv("NEON_MAIN_HOST", mainHost);
    const provide = vi.fn();
    const { default: setup } = await import("./global-setup.ts");
    await expect(setup({ provide } as never)).rejects.toThrow(/recorded in NEON_MAIN_HOST/);
    expect(provide).not.toHaveBeenCalled();
  });

  it("prepareIntegrationDatabase refuses too, for a caller that skips the URL check", async () => {
    vi.stubEnv("NEON_MAIN_HOST", mainHost);
    await expect(prepareIntegrationDatabase(onMain)).rejects.toThrow(/recorded in NEON_MAIN_HOST/);
  });
});

describe("connectionHosts with an odd PGHOST", () => {
  it("does not throw on a PGHOST that is not a host name", () => {
    expect(connectionHosts("postgresql:///db", { PGHOST: "/var/run/postgresql" })).toEqual([
      "/var/run/postgresql",
    ]);
    expect(
      neonMainRefusal("postgresql:///db", "tests", source({ PGHOST: "two words" })),
    ).toBeNull();
  });
});

// Review finding: the guard once parsed the authority differently from
// postgres.js (last '@' against first, '#' as a delimiter, no percent
// decoding), so these URLs passed the guard while postgres.js reached main.
describe("connectionHosts matches postgres.js on crafted URLs", () => {
  const encodedMain = mainHost.replace(".", "%2E");
  const crafted = [
    `postgresql://u:p@${mainHost}%2C127.0.0.1/db`,
    `postgresql://u:p@127.0.0.1#,${mainHost}/db`,
    `postgresql://u:p@${mainHost},z@127.0.0.1/db`,
    `postgresql://u:p@${encodedMain},localhost/db?sslmode=require`,
    `postgresql://u:p@x.invalid#,${mainHost}/db`,
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes every host postgres.js 3.4.9 would try", async () => {
    vi.stubEnv("PGHOST", "");
    for (const url of [...crafted, local, onMain, onMainPooled, "postgresql:///db"]) {
      const sql = postgres(url, { max: 1 });
      const clientHosts = sql.options.host.map((h) => h.toLowerCase());
      await sql.end({ timeout: 0 });
      const guardHosts = connectionHosts(url, {});
      expect(guardHosts).not.toBeNull();
      for (const h of clientHosts) {
        // Pooled endpoints fold onto the direct one; compare after folding.
        expect(guardHosts).toContain(h.replace("-pooler.", "."));
      }
    }
  });

  it("refuses each crafted URL for integration suites with main recorded", () => {
    for (const url of crafted) {
      const refusal = neonMainRefusal(
        url,
        "tests",
        source({ NEON_MAIN_HOST: mainHost, TIDEGRID_EPHEMERAL_DB: "1" }),
      );
      expect(refusal).toMatch(/recorded in NEON_MAIN_HOST/);
      expectNoEcho(refusal);
    }
  });

  it("refuses each crafted URL with no main recorded, and with only the branch flag", () => {
    for (const url of crafted) {
      expect(neonMainRefusal(url, "tests", source())).toMatch(/NEON_MAIN_HOST is not recorded/);
      expect(
        neonMainRefusal(
          url,
          "tests",
          source({ NEON_MAIN_HOST: mainHost, TIDEGRID_NEON_BRANCH: "1" }),
        ),
      ).toMatch(/recorded in NEON_MAIN_HOST/);
    }
  });

  it("refuses each crafted URL for app-role without --neon-main", () => {
    for (const url of crafted) {
      expect(
        neonMainRefusal(
          url,
          { appRole: { neonMain: false } },
          source({ NEON_MAIN_HOST: mainHost }),
        ),
      ).toMatch(/Pass --neon-main/);
    }
  });
});
