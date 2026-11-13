// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockParty } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brand } from "../booking/fixtures.ts";
import { NavigationProvider } from "../navigation.tsx";
import { DockPage } from "./DockPage.tsx";
import { forgetLookup } from "./memory.ts";

const secret = "S".repeat(43);
const token = "T".repeat(43);

function party(overrides: Partial<DockParty> = {}): DockParty {
  return {
    trip: { name: "Sunset Harbor Cruise", when: "Friday, November 13 at 5:00 PM" },
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    people: [
      { position: 1, name: "Ana B.", minor: false, status: "signed", signer: null },
      { position: 2, name: "Kid B.", minor: true, status: "to_sign", signer: "guardian" },
      { position: 3, name: "Lee B.", minor: false, status: "to_sign", signer: "participant" },
      { position: 4, name: "Max B.", minor: false, status: "ask_crew", signer: null },
    ],
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  url: string;
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
      if (init?.credentials !== "omit") throw new Error("credentials must be omitted");
      const headers = new Headers(init?.headers);
      const url = String(input);
      const call: Call = {
        method: init?.method ?? "GET",
        path: new URL(url).pathname,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.get("authorization"),
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

function renderPage(navigate: (href: string) => void = () => {}) {
  window.history.replaceState(null, "", "/dock");
  return render(
    <NavigationProvider navigate={navigate}>
      <DockPage brand={brand} />
    </NavigationProvider>,
  );
}

async function findBooking(code = "7k3m-9pqr", lastName = "Booker") {
  fireEvent.change(screen.getByLabelText("Booking code"), { target: { value: code } });
  fireEvent.change(screen.getByLabelText("Last name of the person who booked"), {
    target: { value: lastName },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find my booking" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  forgetLookup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("the dock page", () => {
  it("finds today's party and starts a signing on this phone, with the secret only as a bearer", async () => {
    const navigate = vi.fn();
    const calls = stubApi((call) => {
      if (call.path === "/v1/public/waiver-dock/lookups") {
        return json(201, { lookupSecret: secret, party: party() });
      }
      if (call.path === "/v1/public/waiver-dock/signings") {
        return json(201, {
          path: `/waiver#t=${token}`,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
      }
      throw new Error(`unexpected ${call.path}`);
    });
    renderPage(navigate);
    await findBooking();
    expect(await screen.findByRole("heading", { name: "Who's signing?" })).toBeTruthy();
    expect(calls[0]?.body).toEqual({ bookingCode: "7k3m-9pqr", lastName: "Booker" });
    // Each person's status is a label, and only waiting people can start.
    expect(screen.getByText("Signed")).toBeTruthy();
    expect(screen.getByText("Ask the crew")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign as parent or guardian for Kid B." }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign for Lee B." }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/waiver#t=${token}`));
    expect(calls[1]?.body).toEqual({ position: 3 });
    expect(calls[1]?.authorization).toBe(`Bearer ${secret}`);
    // The secret is never in a URL or in storage.
    for (const call of calls) expect(call.url).not.toContain(secret);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      secret,
    );
  });

  it("comes back to the party from the signed page, without typing again, and reads it fresh", async () => {
    const signedNow = party({
      people: party().people.map((p) =>
        p.position === 3 ? { ...p, status: "signed", signer: null } : p,
      ),
    });
    const calls = stubApi((call) =>
      call.path === "/v1/public/waiver-dock/party"
        ? json(200, { party: signedNow })
        : json(201, { lookupSecret: secret, party: party() }),
    );
    renderPage();
    await findBooking();
    await screen.findByRole("heading", { name: "Who's signing?" });
    cleanup();
    renderPage();
    expect(screen.getByRole("heading", { name: "Who's signing?" })).toBeTruthy();
    // The person who just signed shows as signed, with no button.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sign for Lee B." })).toBeNull(),
    );
    const read = calls.find((c) => c.path === "/v1/public/waiver-dock/party");
    expect(read?.method).toBe("GET");
    expect(read?.authorization).toBe(`Bearer ${secret}`);
    expect(read?.url).not.toContain(secret);
  });

  it("reads the party again when a waiver no longer waits, and an ended read goes back to the form", async () => {
    let read = json(200, { party: party({ people: party().people.slice(0, 2) }) });
    stubApi((call) => {
      if (call.path === "/v1/public/waiver-dock/lookups")
        return json(201, { lookupSecret: secret, party: party() });
      if (call.path === "/v1/public/waiver-dock/party") return read;
      return refusal(409, "dock_not_pending");
    });
    renderPage();
    await findBooking();
    fireEvent.click(await screen.findByRole("button", { name: "Sign for Lee B." }));
    expect(await screen.findByText("That waiver can't be signed here now")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Lee B.")).toBeNull());
    read = refusal(401, "dock_lookup_ended");
    cleanup();
    renderPage();
    expect(await screen.findByText("Your lookup ended")).toBeTruthy();
  });

  it("says the same for every miss, and sends a held guest to the crew", async () => {
    let answer = refusal(404, "dock_lookup_not_found");
    stubApi(() => answer);
    renderPage();
    await findBooking();
    expect(await screen.findByText("We couldn't find that booking for today")).toBeTruthy();
    answer = refusal(429, "dock_lookup_limited");
    await findBooking();
    expect(await screen.findByText("Too many tries")).toBeTruthy();
    expect(screen.getByText("Ask the crew, who can open your waiver for you.")).toBeTruthy();
  });

  it("asks for both fields before it calls", async () => {
    const calls = stubApi(() => refusal(500, "x"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Find my booking" }));
    expect(screen.getByText("Enter the booking code from your confirmation email")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("explains a crew signing in progress, and an ended lookup sends the guest back to the form", async () => {
    let signing = refusal(409, "dock_crew_signing");
    stubApi((call) =>
      call.path === "/v1/public/waiver-dock/lookups"
        ? json(201, { lookupSecret: secret, party: party() })
        : signing,
    );
    renderPage();
    await findBooking();
    fireEvent.click(await screen.findByRole("button", { name: "Sign for Lee B." }));
    expect(await screen.findByText("The crew is already helping this person sign")).toBeTruthy();
    signing = refusal(401, "dock_lookup_ended");
    fireEvent.click(screen.getByRole("button", { name: "Sign for Lee B." }));
    expect(await screen.findByText("Your lookup ended")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find my booking" })).toBeTruthy();
  });

  it("ignores a Sign answer that arrives after the guest moved on", async () => {
    const navigate = vi.fn();
    let answer: (r: Response) => void = () => {};
    stubApi((call) =>
      call.path === "/v1/public/waiver-dock/lookups"
        ? json(201, { lookupSecret: secret, party: party() })
        : (new Promise<Response>((resolve) => {
            answer = resolve;
          }) as unknown as Response),
    );
    renderPage(navigate);
    await findBooking();
    fireEvent.click(await screen.findByRole("button", { name: "Sign for Lee B." }));
    fireEvent.click(screen.getByRole("button", { name: "Look up another booking" }));
    answer(
      json(201, {
        path: `/waiver#t=${token}`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Find my booking" })).toBeTruthy();
  });

  it("ends the lookup after its 15 minutes by this phone's count, even when the phone's clock is fast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The server says it ends in 15 minutes; this phone's clock is 20 minutes ahead.
    const serverExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
    vi.setSystemTime(Date.now() + 20 * 60_000);
    stubApi(() => json(201, { lookupSecret: secret, party: party({ expiresAt: serverExpiry }) }));
    renderPage();
    await findBooking();
    expect(await screen.findByRole("heading", { name: "Who's signing?" })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(screen.getByRole("heading", { name: "Who's signing?" })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await screen.findByText("Your lookup ended")).toBeTruthy();
  });

  it("tells a busy address to wait, and an unexpected answer to try again", async () => {
    let answer = refusal(429, "rate_limited");
    stubApi(() => answer);
    renderPage();
    await findBooking();
    expect(await screen.findByText("Wait a minute, then try again.")).toBeTruthy();
    answer = refusal(400, "validation_failed");
    await findBooking();
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
  });
});
