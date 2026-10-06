// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GuestParticipantWaiver, ManageWaiversResponse } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartyWaivers, partyWaiverDetail } from "./PartyWaivers.tsx";

const session = "M".repeat(43);
const zone = "America/New_York";

function person(
  position: number,
  name: string,
  status: GuestParticipantWaiver["status"],
  overrides: Partial<GuestParticipantWaiver> = {},
): GuestParticipantWaiver {
  return {
    position,
    name,
    minor: false,
    status,
    signer: "participant",
    signedAt: null,
    sentTo: status === "waiting" ? "a•••@example.test" : null,
    ...overrides,
  };
}

const party: ManageWaiversResponse["waivers"] = {
  applies: true,
  unnamedPlaces: 1,
  participants: [
    person(1, "Ann Adult", "signed", { signedAt: "2026-10-06T19:04:05.000Z" }),
    person(2, "Kit Minor", "waiting", {
      minor: true,
      signer: "guardian",
      sentTo: "g•••@example.test",
    }),
    person(3, "Bo Nomail", "no_address"),
  ],
};

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubApi(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

function show(props: { refresh?: unknown; onEnded?: () => void } = {}) {
  return render(
    <PartyWaivers
      session={session}
      operator="Demo Harbor Charters"
      timeZone={zone}
      refresh={props.refresh ?? 1}
      onEnded={props.onEnded ?? (() => {})}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the party's waivers on the management page", () => {
  it("shows each person's status as an icon and a label, with what to do", async () => {
    stubApi(() => json(200, { waivers: party }));
    show();
    await screen.findByText("1 of 3 signed");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const ann = within(items[0] as HTMLElement);
    expect(ann.getByText("Signed")).toBeTruthy();
    expect(ann.getByText("Signed on October 6.")).toBeTruthy();
    const kit = within(items[1] as HTMLElement);
    expect(kit.getByText("Under 18")).toBeTruthy();
    expect(kit.getByText("Waiting for signature")).toBeTruthy();
    expect(
      kit.getByText("We emailed the link to their parent or guardian at g•••@example.test."),
    ).toBeTruthy();
    const bo = within(items[2] as HTMLElement);
    expect(bo.getByText("Needs an email address")).toBeTruthy();
    expect(
      bo.getByText("Add their email in Who's coming, and we'll send their waiver."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "1 place isn't named yet. Name them in Who's coming, and we'll email their waivers.",
      ),
    ).toBeTruthy();
    // Never color alone: every badge has an icon and words.
    for (const badge of document.querySelectorAll(".tg-status")) {
      expect(badge.querySelector("svg")).not.toBeNull();
      expect(badge.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("sends the booking session only as a bearer header", async () => {
    const calls = stubApi(() => json(200, { waivers: party }));
    show();
    await screen.findByText("1 of 3 signed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toMatch(/\/v1\/public\/manage\/waivers$/);
    expect(calls[0]?.url).not.toContain(session);
    expect(calls[0]?.authorization).toBe(`Bearer ${session}`);
  });

  it("shows nothing when no waiver applies", async () => {
    const calls = stubApi(() =>
      json(200, { waivers: { applies: false, unnamedPlaces: 0, participants: [] } }),
    );
    const { container } = show();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("asks the guest to name the party when nobody is named", async () => {
    stubApi(() => json(200, { waivers: { applies: true, unnamedPlaces: 2, participants: [] } }));
    show();
    await screen.findByText(
      "Name your party in Who's coming, and we'll email each person their waiver.",
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("hands an ended session to the page", async () => {
    stubApi(() => json(401, { error: { code: "session_expired", message: "x", requestId: "r" } }));
    const onEnded = vi.fn();
    show({ onEnded });
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
  });

  it("offers to try again when the first read fails, and reads again", async () => {
    let fail = true;
    const calls = stubApi(() =>
      fail
        ? json(503, { error: { code: "x", message: "x", requestId: "r" } })
        : json(200, { waivers: party }),
    );
    show();
    const retry = await screen.findByRole("button", { name: "Try again" });
    fail = false;
    fireEvent.click(retry);
    await screen.findByText("1 of 3 signed");
    expect(calls).toHaveLength(2);
  });

  it("reads again when the party changes, keeping what it shows meanwhile", async () => {
    let signed = false;
    const calls = stubApi(() =>
      json(200, {
        waivers: {
          ...party,
          participants: party.participants.map((p) =>
            signed && p.position === 2
              ? { ...p, status: "signed", signedAt: "2026-10-06T20:00:00.000Z", sentTo: null }
              : p,
          ),
        },
      }),
    );
    const view = show({ refresh: "first" });
    await screen.findByText("1 of 3 signed");
    signed = true;
    view.rerender(
      <PartyWaivers
        session={session}
        operator="Demo Harbor Charters"
        timeZone={zone}
        refresh="second"
        onEnded={() => {}}
      />,
    );
    expect(screen.getByText("1 of 3 signed")).toBeTruthy();
    await screen.findByText("2 of 3 signed");
    expect(screen.getByText("Signed by a parent or guardian on October 6.")).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it("reads again when the tab comes back into view, at most every ten seconds", async () => {
    const calls = stubApi(() => json(200, { waivers: party }));
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    show();
    await screen.findByText("1 of 3 signed");
    const visible = () =>
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    now.mockReturnValue(1_005_000);
    visible();
    expect(calls).toHaveLength(1);
    now.mockReturnValue(1_011_000);
    visible();
    await waitFor(() => expect(calls).toHaveLength(2));
    now.mockRestore();
  });
});

describe("what each status tells the booker", () => {
  const detail = (p: GuestParticipantWaiver) => partyWaiverDetail(p, "Demo Reef Divers", zone);

  it("names the operator when only they can help", () => {
    expect(detail(person(1, "A", "not_assigned"))).toBe(
      "Demo Reef Divers hasn't sent this waiver yet. Contact them if your trip is soon.",
    );
    expect(detail(person(1, "A", "email_failed", { sentTo: "a•••@example.test" }))).toBe(
      "The email to a•••@example.test didn't go through. Check the address in Who's coming, or contact Demo Reef Divers.",
    );
  });

  it("asks for a guardian's address for a minor", () => {
    expect(detail(person(1, "K", "no_address", { minor: true, signer: "guardian" }))).toBe(
      "Add a parent or guardian's email in Who's coming, and we'll send it.",
    );
  });

  it("reads the signing day on the marina's calendar", () => {
    // 03:30 UTC on October 7 is still October 6 in New York.
    expect(detail(person(1, "A", "signed", { signedAt: "2026-10-07T03:30:00.000Z" }))).toBe(
      "Signed on October 6.",
    );
  });

  it("says nothing more for a status with nothing to do", () => {
    expect(detail(person(1, "A", "not_required"))).toBeNull();
  });
});
