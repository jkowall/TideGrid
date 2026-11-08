import { describe, expect, it } from "vitest";
import { parseAppRoleArgs } from "./app-role.ts";
import { type NeonGuardSource, neonMainRefusal } from "./testing.ts";

// Synthetic hosts only. None is a real endpoint.
const mainHost = "ep-main-000000.us-east-2.aws.neon.tech";
const onMain = `postgresql://owner:pw-not-real@${mainHost}/neondb?sslmode=require`;
const onBranch = "postgresql://owner:pw-not-real@ep-branch-111111.us-east-2.aws.neon.tech/neondb";
const local = "postgresql://postgres:postgres@127.0.0.1:55432/tidegrid";

const source = (env: Record<string, string> = {}): NeonGuardSource => ({
  env,
  readEnvLocal: () => null,
});
const plain = { appRole: { neonMain: false } };
const optIn = { appRole: { neonMain: true } };

function expectNoEcho(message: string | null) {
  expect(message).not.toBeNull();
  for (const part of [mainHost, "ep-main", "ep-branch", "pw-not-real", "owner"]) {
    expect(message).not.toContain(part);
  }
}

describe("app-role flags", () => {
  it("takes only --neon-main", () => {
    expect(parseAppRoleArgs([])).toEqual({ neonMain: false });
    expect(parseAppRoleArgs(["--neon-main"])).toEqual({ neonMain: true });
    expect(parseAppRoleArgs(["--", "--neon-main"])).toEqual({ neonMain: true });
    expect(() => parseAppRoleArgs(["--neon"])).toThrow(/unknown argument/);
    expect(() => parseAppRoleArgs([onMain])).toThrow(/unknown argument/);
  });

  it("does not echo an unknown argument, which could be a URL", () => {
    expect(() => parseAppRoleArgs([onMain])).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("pw-not-real") }),
    );
  });
});

describe("neonMainRefusal for app-role:password", () => {
  it("refuses the recorded main host unless --neon-main is given", () => {
    const s = source({ NEON_MAIN_HOST: mainHost, TIDEGRID_NEON_BRANCH: "1" });
    const refusal = neonMainRefusal(onMain, plain, s);
    expect(refusal).toMatch(/Pass --neon-main/);
    expect(refusal).toMatch(/rule 4/);
    expectNoEcho(refusal);
    expect(neonMainRefusal(onMain, optIn, s)).toBeNull();
  });

  it("allows other databases without the flag once main is recorded", () => {
    const s = source({ NEON_MAIN_HOST: mainHost });
    expect(neonMainRefusal(onBranch, plain, s)).toBeNull();
    expect(neonMainRefusal(local, plain, s)).toBeNull();
  });

  it("refuses --neon-main for a database that is not main", () => {
    const refusal = neonMainRefusal(onBranch, optIn, source({ NEON_MAIN_HOST: mainHost }));
    expect(refusal).toMatch(/--neon-main was given/);
    expectNoEcho(refusal);
    expect(neonMainRefusal(local, optIn, source())).toMatch(/--neon-main was given/);
  });

  it("with main missing, refuses a Neon host unless a flag says which it is", () => {
    const refusal = neonMainRefusal(onMain, plain, source());
    expect(refusal).toMatch(/--neon-main/);
    expect(refusal).toMatch(/TIDEGRID_NEON_BRANCH=1/);
    expectNoEcho(refusal);
    expect(neonMainRefusal(onMain, optIn, source())).toBeNull();
    expect(neonMainRefusal(onBranch, plain, source({ TIDEGRID_NEON_BRANCH: "1" }))).toBeNull();
    expect(neonMainRefusal(local, plain, source())).toBeNull();
  });

  it("refuses malformed values without echoing them", () => {
    const badMain = neonMainRefusal(local, optIn, source({ NEON_MAIN_HOST: onMain }));
    expect(badMain).toMatch(/not a bare host name/);
    expectNoEcho(badMain);
    const badUrl = neonMainRefusal(
      "postgresql://owner:pw-not-real@ep-main-000000.neon.tech:0x/db",
      optIn,
      source(),
    );
    expect(badUrl).toMatch(/not a valid connection URL/);
    expectNoEcho(badUrl);
  });
});

describe("app-role refusal wording", () => {
  it("names the Nov 1 runbook, not a release runbook", () => {
    const s = source({ NEON_MAIN_HOST: mainHost });
    for (const refusal of [
      neonMainRefusal(onMain, plain, s),
      neonMainRefusal(onMain, plain, source()),
    ]) {
      expect(refusal).toMatch(/Nov 1 runbook rule 4/);
      expect(refusal).not.toMatch(/release runbook/);
    }
  });

  it("does not mention a recorded host for --neon-main when none is recorded", () => {
    const refusal = neonMainRefusal(local, optIn, source());
    expect(refusal).toMatch(/--neon-main was given/);
    expect(refusal).toMatch(/not a Neon host/);
    expect(refusal).not.toMatch(/recorded in NEON_MAIN_HOST/);
    expectNoEcho(refusal);
  });
});
