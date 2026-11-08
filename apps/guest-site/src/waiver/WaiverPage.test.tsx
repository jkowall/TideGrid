// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WaiverSigning } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brand } from "../booking/fixtures.ts";
import { NavigationProvider } from "../navigation.tsx";
import { WaiverPage } from "./WaiverPage.tsx";

const token = "T".repeat(43);
const secret = "S".repeat(43);
const hash = "a".repeat(64);

function waiver(overrides: Partial<WaiverSigning> = {}): WaiverSigning {
  return {
    state: "pending",
    operatorName: "Demo Harbor Charters",
    trip: {
      name: "Sunset Harbor Cruise",
      when: "Saturday, November 7, 2026 at 6:00 PM EST",
      place: "Harbor Marina, Dock C",
      bookingReference: "7KQ2M9XA",
    },
    participant: { name: "Ann Adult", minor: false, signerName: "Ann Adult" },
    signerRole: "participant",
    waiver: {
      title: "Demo Harbor Charters participation waiver",
      version: 1,
      body: "Demo text.\n\nBoating has risks.",
      acknowledgments: ["I have read this waiver in full.", "I accept the risks."],
      contentSha256: hash,
    },
    consent: { version: "esign-v1", text: "I agree to sign this waiver electronically." },
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    access: "email_link",
    signed: null,
    ...overrides,
  };
}

const signedWaiver = () =>
  waiver({
    state: "signed",
    signed: {
      signedAt: "2026-10-06T19:04:05.000Z",
      signerName: "Ann Adult",
      signerRole: "participant",
      relationship: null,
      documentSha256: "b".repeat(64),
    },
  });

interface Call {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string) =>
  json(status, { error: { code, message: code, requestId: "r" } });

function stubApi(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.get("authorization"),
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

function renderPage() {
  return render(
    <NavigationProvider navigate={() => {}}>
      <WaiverPage brand={brand} />
    </NavigationProvider>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", `/waiver#t=${token}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the waiver page", () => {
  it("takes the token from the fragment, clears it, and spends it only on the guest's tap", async () => {
    const calls = stubApi(() => json(201, { sessionSecret: secret, waiver: waiver() }));
    renderPage();
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("heading", { name: "Sign your waiver" })).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByRole("heading", { name: "Demo Harbor Charters participation waiver" });
    expect(calls).toEqual([
      {
        method: "POST",
        url: expect.stringMatching(/\/v1\/public\/waiver-sessions$/),
        body: { token },
        authorization: null,
      },
    ]);
    // Neither secret ever reaches an address.
    for (const call of calls) {
      expect(call.url).not.toContain(token);
      expect(call.url).not.toContain(secret);
    }
  });

  it("checks the form first, then signs with the session's secret, and offers the signed copy", async () => {
    const calls = stubApi((call) => {
      if (call.url.endsWith("/waiver-sessions")) {
        return json(201, { sessionSecret: secret, waiver: waiver() });
      }
      if (call.url.endsWith("/signature")) {
        const body = call.body as { signature: string };
        return body.signature === "Ann Adult"
          ? json(201, { waiver: signedWaiver() })
          : json(422, {
              error: { code: "signature_invalid", message: "fix", requestId: "r" },
              problems: [
                {
                  field: "signature",
                  code: "does_not_match",
                  message: "Type your name as it appears on this booking: Ann Adult",
                },
              ],
            });
      }
      return new Response(new Blob(["%PDF-1.4"]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByText("Boating has risks.");

    // Nothing checked: the page says what to fix and sends nothing.
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    expect(screen.getByText("Check every statement to sign")).toBeTruthy();
    expect(screen.getByText("Agree to sign electronically to continue")).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/signature"))).toEqual([]);

    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.change(screen.getByLabelText("Type your full name to sign"), {
      target: { value: "Someone Else" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await screen.findByText("Type your name as it appears on this booking: Ann Adult");

    fireEvent.change(screen.getByLabelText("Type your full name to sign"), {
      target: { value: "Ann Adult" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await screen.findByRole("heading", { name: "Waiver signed" });
    const signCall = calls.filter((c) => c.url.endsWith("/signature")).at(-1);
    expect(signCall).toMatchObject({
      method: "POST",
      authorization: `Bearer ${secret}`,
      body: {
        contentSha256: hash,
        acknowledgments: [true, true],
        consent: true,
        confirmIdentity: true,
        signature: "Ann Adult",
        relationship: null,
      },
    });

    const createObjectURL = vi.fn(() => "blob:waiver");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const saved = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Download your signed copy" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
    saved.mockRestore();
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      url: expect.stringMatching(/\/v1\/public\/waiver-sessions\/current\/document$/),
      authorization: `Bearer ${secret}`,
    });
  });

  it("asks a guardian for the relationship and sends it", async () => {
    const guardianWaiver = waiver({
      signerRole: "guardian",
      participant: { name: "Kit Minor", minor: true, signerName: "Gus Guardian" },
    });
    const calls = stubApi((call) =>
      call.url.endsWith("/signature")
        ? json(201, { waiver: signedWaiver() })
        : json(201, { sessionSecret: secret, waiver: guardianWaiver }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByText("I am Kit Minor's parent or legal guardian, and I can sign for them.");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.change(screen.getByLabelText("Type your full name to sign"), {
      target: { value: "Gus Guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    expect(
      screen.getByText("Choose whether you are the parent or the legal guardian"),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your relationship to Kit Minor"), {
      target: { value: "legal_guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await screen.findByRole("heading", { name: "Waiver signed" });
    expect(calls.at(-1)?.body).toMatchObject({ relationship: "legal_guardian" });
  });

  it.each([
    ["waiver_link_used", 409, "This link was already opened"],
    ["waiver_link_expired", 409, "This link has expired"],
    ["waiver_link_replaced", 409, "There's a newer link"],
    ["waiver_link_invalid", 404, "This waiver link doesn't work here"],
    ["waiver_signed", 409, "This waiver is already signed"],
    ["waiver_superseded", 409, "This waiver was updated"],
  ])("shows a designed screen for %s", async (code, status, title) => {
    stubApi(() => refusal(status, code));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByRole("heading", { name: title });
  });

  it("keeps the token when the network fails, so the guest can tap again", async () => {
    let first = true;
    stubApi(() => {
      if (first) {
        first = false;
        throw new TypeError("offline");
      }
      return json(201, { sessionSecret: secret, waiver: waiver() });
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByText("Check your connection, then try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Boating has risks.");
  });

  it("keeps the token after too many tries, and tries again with the same one", async () => {
    let first = true;
    const calls = stubApi(() => {
      if (first) {
        first = false;
        return refusal(429, "rate_limited");
      }
      return json(201, { sessionSecret: secret, waiver: waiver() });
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByText("Wait a minute, then try again. Your link still works.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Boating has risks.");
    expect(calls.map((c) => c.body)).toEqual([{ token }, { token }]);
  });

  it("keeps the filled form after too many tries to sign, and signs on the next tap", async () => {
    let tries = 0;
    stubApi((call) => {
      if (call.url.endsWith("/waiver-sessions")) {
        return json(201, { sessionSecret: secret, waiver: waiver() });
      }
      tries += 1;
      return tries === 1 ? refusal(429, "rate_limited") : json(201, { waiver: signedWaiver() });
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByText("Boating has risks.");
    // An empty name names the problem, not the label again.
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    expect(screen.getByText("Enter your full name to sign")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Type your full name to sign"), {
      target: { value: "Ann Adult" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await screen.findByText("Nothing was signed. Wait a minute, then sign again.");
    expect((screen.getByLabelText("Type your full name to sign") as HTMLInputElement).value).toBe(
      "Ann Adult",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await screen.findByRole("heading", { name: "Waiver signed" });
  });

  it("picks a session up again after a reload, and says when there is no link", async () => {
    window.history.replaceState(null, "", "/waiver");
    const calls = stubApi(() => json(200, { waiver: waiver() }));
    window.sessionStorage.setItem(
      "tidegrid.waiver.session",
      JSON.stringify({ secret, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    renderPage();
    await screen.findByText("Boating has risks.");
    expect(calls[0]).toMatchObject({ method: "GET", authorization: `Bearer ${secret}` });
    cleanup();

    window.sessionStorage.clear();
    renderPage();
    expect(screen.getByRole("heading", { name: "Open the link from your email" })).toBeTruthy();
  });

  it("says the trip has ended when a signature comes too late, and forgets the session", async () => {
    stubApi((call) =>
      call.url.endsWith("/waiver-sessions")
        ? json(201, { sessionSecret: secret, waiver: waiver() })
        : refusal(409, "waiver_trip_over"),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
    await screen.findByText("Boating has risks.");
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.change(screen.getByLabelText("Type your full name to sign"), {
      target: { value: "Ann Adult" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await screen.findByRole("heading", { name: "This trip has ended" });
    expect(window.sessionStorage.getItem("tidegrid.waiver.session")).toBeNull();
  });

  it.each([
    ["waiver_signed", "This waiver is already signed"],
    ["waiver_superseded", "This waiver was updated"],
    ["waiver_not_needed", "This waiver is no longer needed"],
  ])("says why a reloaded session ended (%s), and forgets it", async (code, title) => {
    window.history.replaceState(null, "", "/waiver");
    stubApi(() => refusal(409, code));
    window.sessionStorage.setItem(
      "tidegrid.waiver.session",
      JSON.stringify({ secret, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    renderPage();
    await screen.findByRole("heading", { name: title });
    expect(window.sessionStorage.getItem("tidegrid.waiver.session")).toBeNull();
  });

  describe("on a shared device (a staff-assisted link)", () => {
    const signFlow = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
      await screen.findByText("Boating has risks.");
      for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
      fireEvent.change(screen.getByLabelText("Type your full name to sign"), {
        target: { value: "Ann Adult" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
      await screen.findByRole("heading", { name: "Waiver signed" });
    };

    it("keeps the secret in memory only, and after Done ends the session and forgets everything", async () => {
      const staff = waiver({ access: "staff_device" });
      const calls = stubApi((call) => {
        if (call.url.endsWith("/waiver-sessions")) {
          return json(201, { sessionSecret: secret, waiver: staff });
        }
        if (call.method === "DELETE") return new Response(null, { status: 204 });
        return json(201, { waiver: { ...signedWaiver(), access: "staff_device" } });
      });
      renderPage();
      await signFlow();
      expect(window.sessionStorage.getItem("tidegrid.waiver.session")).toBeNull();
      // The operator keeps the copy; the shared device is not offered one.
      expect(screen.queryByRole("button", { name: "Download your signed copy" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await screen.findByRole("heading", { name: "All done. Hand the device back" });
      expect(screen.queryByText("Ann Adult")).toBeNull();
      expect(calls.at(-1)).toMatchObject({
        method: "DELETE",
        url: expect.stringMatching(/\/v1\/public\/waiver-sessions\/current$/),
        authorization: `Bearer ${secret}`,
      });
      for (const call of calls) expect(call.url).not.toContain(secret);
    });

    it("clears itself after 2 minutes untouched while reading, and not before", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const calls = stubApi((call) =>
          call.method === "DELETE"
            ? new Response(null, { status: 204 })
            : json(201, {
                sessionSecret: secret,
                waiver: waiver({ access: "participant_qr" }),
              }),
        );
        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
        await screen.findByText("Boating has risks.");
        await vi.advanceTimersByTimeAsync(90_000);
        // A touch restarts the clock.
        fireEvent.pointerDown(window);
        await vi.advanceTimersByTimeAsync(90_000);
        expect(screen.getByText("Boating has risks.")).toBeTruthy();
        expect(screen.queryByText("Still there?")).toBeNull();
        // Twenty seconds before, a warning; a tap would keep the page.
        await vi.advanceTimersByTimeAsync(11_000);
        expect(await screen.findByText("Still there?")).toBeTruthy();
        expect(screen.getByText("Boating has risks.")).toBeTruthy();
        await vi.advanceTimersByTimeAsync(20_000);
        await screen.findByRole("heading", { name: "This page was cleared" });
        expect(screen.queryByText("Boating has risks.")).toBeNull();
        expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
        expect(window.sessionStorage.getItem("tidegrid.waiver.session")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("offers the copy after a QR signature, then clears after 2 minutes", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        stubApi((call) => {
          if (call.url.endsWith("/waiver-sessions")) {
            return json(201, {
              sessionSecret: secret,
              waiver: waiver({ access: "participant_qr" }),
            });
          }
          if (call.method === "DELETE") return new Response(null, { status: 204 });
          return json(201, { waiver: { ...signedWaiver(), access: "participant_qr" } });
        });
        renderPage();
        await signFlow();
        expect(screen.getByRole("button", { name: "Download your signed copy" })).toBeTruthy();
        await vi.advanceTimersByTimeAsync(121_000);
        // Never told to sign again: the waiver is signed.
        await screen.findByRole("heading", { name: "Signed, and this page was cleared" });
        expect(screen.queryByText(/start it again/)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("after Done on the guest's own phone, says all done without asking to hand it back", async () => {
      stubApi((call) => {
        if (call.url.endsWith("/waiver-sessions")) {
          return json(201, { sessionSecret: secret, waiver: waiver({ access: "participant_qr" }) });
        }
        if (call.method === "DELETE") return new Response(null, { status: 204 });
        return json(201, { waiver: { ...signedWaiver(), access: "participant_qr" } });
      });
      renderPage();
      await signFlow();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await screen.findByRole("heading", { name: "All done" });
    });

    it("never clears an emailed link's page by itself", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        stubApi(() => json(201, { sessionSecret: secret, waiver: waiver() }));
        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Open my waiver" }));
        await screen.findByText("Boating has risks.");
        await vi.advanceTimersByTimeAsync(300_000);
        expect(screen.getByText("Boating has risks.")).toBeTruthy();
        expect(window.sessionStorage.getItem("tidegrid.waiver.session")).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
