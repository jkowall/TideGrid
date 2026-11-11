// @vitest-environment jsdom

// The person is in Tokyo and the marina in New York: the trip's time is the marina's.
process.env.TZ = "Asia/Tokyo";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ParticipantProfile } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brand } from "../booking/fixtures.ts";
import { NavigationProvider } from "../navigation.tsx";
import { departsText, ParticipantPage } from "./ParticipantPage.tsx";
import { loadSession, storeSession } from "./session.ts";

const token = "T".repeat(43);
const secret = "S".repeat(43);
const storageKey = "tidegrid.participant.v1";

function profile(overrides: Partial<ParticipantProfile> = {}): ParticipantProfile {
  return {
    participant: {
      id: "0b8e7a43-8f5e-4f0e-9d0e-6a1c2b3d4e5f",
      position: 2,
      name: "Ann Adult",
      isMinor: false,
      email: "ann@example.test",
      guardian: null,
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
    },
    bookingState: "confirmed",
    trip: {
      productName: "Sunset Harbor Cruise",
      startsAt: "2026-11-07T23:00:00.000Z",
      timeZone: "America/New_York",
      departed: false,
    },
    location: {
      name: "Harbor Marina",
      meetingPoint: "Dock C",
      meetingInstructions: "Check in 20 minutes early.",
    },
    bookedBy: "Bea",
    editable: true,
    ...overrides,
  };
}

const minorProfile = () =>
  profile({
    participant: {
      ...profile().participant,
      name: "Mia Minor",
      isMinor: true,
      email: null,
      guardian: { name: "Gus Guardian", email: "gus@example.test" },
    },
  });

interface Call {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
  key: string | null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string) =>
  json(status, { error: { code, message: code, requestId: "r" } });
const opened = () =>
  json(201, {
    session: { token: secret, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });

function stubApi(answer: (call: Call) => Response | Promise<Response>): Call[] {
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
        key: headers.get("idempotency-key"),
      };
      if (init?.credentials !== "omit") throw new Error("credentials must be omitted");
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

/** The usual API: opens, reads, and saves as asked. */
function api(
  read: () => ParticipantProfile = profile,
  save?: (call: Call) => Response | Promise<Response>,
) {
  return stubApi((call) => {
    const path = new URL(call.url).pathname;
    if (call.method === "POST" && path === "/v1/public/participant-access") return opened();
    if (call.method === "GET" && path === "/v1/public/participant/profile") {
      return json(200, { profile: read() });
    }
    if (call.method === "PUT" && path === "/v1/public/participant/profile") {
      if (save) return save(call);
      const body = call.body as { name: string; email: string | null };
      const before = read();
      return json(200, {
        profile: { ...before, participant: { ...before.participant, ...body } },
        changed: true,
      });
    }
    if (call.method === "POST" && path === "/v1/public/participant/session/end") {
      return json(200, { ended: true });
    }
    throw new Error(`unexpected ${call.method} ${path}`);
  });
}

const paths = (calls: Call[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
const text = (element: Element | null | undefined) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const facts = () =>
  [...document.querySelectorAll(".waiver-facts > div")].map(
    (row) => `${text(row.querySelector("dt"))} ${text(row.querySelector("dd"))}`,
  );

function renderPage(address = `/participant#t=${token}`) {
  window.history.replaceState(null, "", address);
  return render(
    <NavigationProvider navigate={() => {}}>
      <ParticipantPage brand={brand} />
    </NavigationProvider>,
  );
}

async function openDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Open my details" }));
  return screen.findByRole("heading", { level: 1, name: /trip details$/ });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("opening an invitation", () => {
  it("takes the token from the fragment, clears it, and spends it only on the person's tap", async () => {
    const calls = api();
    renderPage();
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("heading", { name: "Check your trip details" })).toBeTruthy();
    expect(calls).toEqual([]);
    await openDetails();
    expect(paths(calls)).toEqual([
      "POST /v1/public/participant-access",
      "GET /v1/public/participant/profile",
    ]);
    expect(calls[0]?.body).toEqual({ token });
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[1]?.authorization).toBe(`Bearer ${secret}`);
    // Neither secret ever reaches an address.
    for (const call of calls) {
      expect(call.url).not.toContain(token);
      expect(call.url).not.toContain(secret);
    }
    expect(loadSession()?.token).toBe(secret);
  });

  it("shows the trip on the marina's clock, where to meet, and who booked, and nothing of the rest of the party", async () => {
    api();
    renderPage();
    await openDetails();
    expect(facts()).toEqual([
      "Trip Sunset Harbor Cruise",
      "Departs Saturday, November 7 at 6:00 PM (New York time)",
      "From Harbor Marina, Dock C",
      "Meeting Check in 20 minutes early.",
      "Booked by Bea",
    ]);
    expect(
      (screen.getByRole("textbox", { name: "Your full name" }) as HTMLInputElement).value,
    ).toBe("Ann Adult");
    expect(
      (screen.getByRole("textbox", { name: "Your email (optional)" }) as HTMLInputElement).value,
    ).toBe("ann@example.test");
    // Whether someone is a minor is the booker's to set.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it.each([
    ["link_used", 410, "This link was already opened"],
    ["link_expired", 410, "This link has expired"],
    ["link_superseded", 410, "There's a newer link"],
    ["link_revoked", 410, "This link no longer works"],
    ["invitation_closed", 410, "This booking no longer takes changes"],
    ["link_not_found", 404, "This link doesn't work here"],
  ])("says what a %s refusal means", async (code, status, title) => {
    stubApi(() => refusal(status, code));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open my details" }));
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(loadSession()).toBeNull();
  });

  it("keeps the token for another tap when there is no answer, or too many tries", async () => {
    let answer = 0;
    const calls = stubApi((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/v1/public/participant-access") {
        answer += 1;
        if (answer === 1) throw new TypeError("offline");
        if (answer === 2) return refusal(429, "rate_limited");
        return opened();
      }
      return json(200, { profile: profile() });
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open my details" }));
    expect(await screen.findByText("We couldn't reach the booking system")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Too many tries")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 1, name: "Your trip details" });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { token },
      { token },
      { token },
    ]);
  });

  it("asks for the email's link when the page opens without one", async () => {
    const calls = api();
    renderPage("/participant");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Open the link from your email" }),
    ).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("says the session ended, not that the link is missing, when a reload finds it run out", async () => {
    const calls = api();
    storeSession({ token: secret, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    renderPage("/participant");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your session ended" }),
    ).toBeTruthy();
    expect(calls).toEqual([]);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("forgets a person this tab had open when a new invitation arrives", async () => {
    const calls = api();
    storeSession({ token: secret, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    renderPage();
    expect(screen.getByRole("heading", { name: "Check your trip details" })).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("starts over, without spending it, when another invitation opens in this tab", async () => {
    const calls = api();
    renderPage();
    await openDetails();
    const other = "U".repeat(43);
    window.history.replaceState(null, "", `/participant#t=${other}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Check your trip details" }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    await waitFor(() => expect(paths(calls)).toContain("POST /v1/public/participant/session/end"));
    expect(calls.filter((c) => c.method === "POST" && c.body !== undefined)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open my details" }));
    await screen.findByRole("heading", { level: 1, name: "Your trip details" });
    expect(
      calls
        .filter((c) => new URL(c.url).pathname.endsWith("participant-access"))
        .map((c) => c.body),
    ).toEqual([{ token }, { token: other }]);
  });

  it("picks the session up again after a reload", async () => {
    const calls = api();
    storeSession({ token: secret, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    renderPage("/participant");
    await screen.findByRole("heading", { level: 1, name: "Your trip details" });
    expect(paths(calls)).toEqual(["GET /v1/public/participant/profile"]);
  });

  it("says the session ended, and forgets it, when the API says so", async () => {
    stubApi(() => refusal(401, "session_expired"));
    storeSession({ token: secret, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    renderPage("/participant");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your session ended" }),
    ).toBeTruthy();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });
});

describe("correcting your details", () => {
  it("saves the corrected details once, with a key, and says so", async () => {
    const calls = api();
    renderPage();
    await openDetails();
    fireEvent.change(screen.getByRole("textbox", { name: "Your full name" }), {
      target: { value: " Ann B. Adult " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Your email (optional)" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Demo Harbor Charters has the new details.")).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ name: "Ann B. Adult", email: null, guardian: null });
    expect(put?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(put?.authorization).toBe(`Bearer ${secret}`);
  });

  it("checks the form before sending", async () => {
    const calls = api();
    renderPage();
    await openDetails();
    const name = screen.getByRole("textbox", { name: "Your full name" });
    fireEvent.change(name, { target: { value: " " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Your email (optional)" }), {
      target: { value: "not an address" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Enter their full name")).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("asks a minor's guardian for the guardian's details, and keeps the minor a minor", async () => {
    const calls = api(minorProfile);
    renderPage();
    await screen.findByRole("button", { name: "Open my details" });
    fireEvent.click(screen.getByRole("button", { name: "Open my details" }));
    await screen.findByRole("heading", { level: 1, name: "Mia Minor's trip details" });
    fireEvent.change(screen.getByRole("textbox", { name: "Parent or guardian's email" }), {
      target: { value: "gus.g@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByText("Saved");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      name: "Mia Minor",
      email: null,
      guardian: { name: "Gus Guardian", email: "gus.g@example.test" },
    });
  });

  it("sends the same key again after no answer, so a retry saves once", async () => {
    let tries = 0;
    const calls = api(profile, () => {
      tries += 1;
      if (tries === 1) throw new TypeError("offline");
      return json(200, { profile: profile(), changed: false });
    });
    renderPage();
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText(/couldn't reach the booking system/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Demo Harbor Charters already had these details.")).toBeTruthy();
    const keys = calls.filter((c) => c.method === "PUT").map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it.each([
    ["session_expired", 401, "Your session ended"],
    ["participant_not_found", 404, "This person is no longer in the booking"],
    ["trip_departed", 409, "This booking no longer takes changes"],
    ["booking_canceled", 409, "This booking no longer takes changes"],
  ])("stops on %s", async (code, status, title) => {
    api(profile, () => refusal(status, code));
    renderPage();
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(loadSession()).toBeNull();
  });

  it("shows the details without a form once the trip has left", async () => {
    api(() => profile({ editable: false, trip: { ...profile().trip, departed: true } }));
    renderPage();
    await openDetails();
    expect(screen.getByText("These details can't change now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save details" })).toBeNull();
    expect(facts()).toContain("Name Ann Adult");
  });

  it("ends the session on I'm done, and forgets it", async () => {
    const calls = api();
    renderPage();
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "I'm done" }));
    expect(await screen.findByRole("heading", { level: 1, name: "All done" })).toBeTruthy();
    await waitFor(() => expect(paths(calls)).toContain("POST /v1/public/participant/session/end"));
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });
});

describe("an answer that arrives late", () => {
  it("leaves the done screen alone when a save answers after I'm done", async () => {
    let release: (r: Response) => void = () => {};
    api(
      profile,
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    renderPage();
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    fireEvent.click(screen.getByRole("button", { name: "I'm done" }));
    await screen.findByRole("heading", { level: 1, name: "All done" });
    release(json(200, { profile: profile(), changed: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("heading", { level: 1, name: "All done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save details" })).toBeNull();
  });
});

describe("departsText", () => {
  it("reads the trip's own clock", () => {
    expect(departsText("2026-07-04T13:30:00.000Z", "America/Los_Angeles")).toBe(
      "Saturday, July 4 at 6:30 AM (Los Angeles time)",
    );
  });
});
