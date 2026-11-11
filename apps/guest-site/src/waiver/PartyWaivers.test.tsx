// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GuestParticipantWaiver, ManageWaiversResponse } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canResend, PartyWaivers, partyWaiverDetail, resendProblem } from "./PartyWaivers.tsx";

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
    sendsAt: null,
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
  body: unknown;
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
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
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
    // A screen reader hears the name and the tag apart.
    expect((items[1] as HTMLElement).querySelector(".wv-party__name")?.textContent).toBe(
      "Kit Minor, Under 18",
    );
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

  it("says when a held email goes out, and when one cannot be sent yet", () => {
    expect(detail(person(1, "A", "waiting", { sendsAt: "2026-10-06T19:14:05.000Z" }))).toBe(
      "We'll email the link to a•••@example.test at 3:14 PM EDT.",
    );
    expect(detail(person(1, "A", "email_held"))).toBe(
      "We can't email this address again just yet. Demo Reef Divers can send it once it's allowed.",
    );
  });
});

describe("sending a person's waiver again", () => {
  const sentAgain: ManageWaiversResponse["waivers"] = {
    ...party,
    participants: party.participants.map((p) => (p.position === 2 ? { ...p } : p)),
  };

  it("offers it only to people whose email went out and who haven't signed", async () => {
    stubApi(() => json(200, { waivers: party }));
    show();
    await screen.findByText("1 of 3 signed");
    const buttons = screen.getAllByRole("button", { name: /^Send again/ });
    expect(buttons.map((b) => b.textContent)).toEqual(["Send again to Kit Minor"]);
    expect(canResend(person(1, "A", "email_failed", { sentTo: "a•••@example.test" }))).toBe(true);
    expect(canResend(person(1, "A", "email_failed"))).toBe(false);
    expect(canResend(person(1, "A", "waiting", { sendsAt: "2026-10-06T19:14:05.000Z" }))).toBe(
      false,
    );
    expect(canResend(person(1, "A", "email_held"))).toBe(false);
    expect(canResend(person(1, "A", "signed"))).toBe(false);
  });

  it("sends it with the booking session and the person's place, then says where it went", async () => {
    const calls = stubApi((call) =>
      call.method === "POST" ? json(202, { waivers: sentAgain }) : json(200, { waivers: party }),
    );
    show();
    await screen.findByText("1 of 3 signed");
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    const note = await screen.findByText(
      "Sent again to g•••@example.test. Ask them to check their inbox and spam folder.",
    );
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toMatch(/\/v1\/public\/manage\/waivers\/resend$/);
    expect(post?.url).not.toContain(session);
    expect(post?.authorization).toBe(`Bearer ${session}`);
    expect(post?.body).toEqual({ position: 2, name: "Kit Minor" });
    // The button goes, and its note takes focus so the result is heard.
    expect(screen.queryByRole("button", { name: /^Send again/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(note));
  });

  it("explains a refusal beside the person, and keeps the button", async () => {
    stubApi((call) =>
      call.method === "POST"
        ? json(409, { error: { code: "waiver_resend_too_soon", message: "x", requestId: "r" } })
        : json(200, { waivers: party }),
    );
    show();
    await screen.findByText("1 of 3 signed");
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    const item = (
      await screen.findByText(
        "We emailed this address in the last 10 minutes. Try again a little later.",
      )
    ).closest("li") as HTMLElement;
    expect(within(item).getByRole("button", { name: "Send again to Kit Minor" })).toBeTruthy();
  });

  it("reads again when the waiver changed, and hands an ended session to the page", async () => {
    let answer = 409;
    const calls = stubApi((call) =>
      call.method === "POST"
        ? json(answer, {
            error: {
              code: answer === 409 ? "waiver_not_pending" : "session_expired",
              message: "x",
              requestId: "r",
            },
          })
        : json(200, { waivers: party }),
    );
    const onEnded = vi.fn();
    show({ onEnded });
    await screen.findByText("1 of 3 signed");
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    await screen.findByText(
      "This waiver changed since the page loaded. The list now shows where it stands.",
    );
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
    answer = 401;
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
  });

  it("drops a sent note once the list shows the person differently", async () => {
    let list = party;
    stubApi((call) =>
      call.method === "POST" ? json(202, { waivers: party }) : json(200, { waivers: list }),
    );
    const view = show({ refresh: 1 });
    await screen.findByText("1 of 3 signed");
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    await screen.findByText(/^Sent again to g•••@example.test/);
    // The booker corrects the address in Who's coming, and the page reads again.
    list = {
      ...party,
      participants: party.participants.map((p) =>
        p.position === 2 ? { ...p, sentTo: "n•••@example.test" } : p,
      ),
    };
    view.rerender(
      <PartyWaivers
        session={session}
        operator="Demo Harbor Charters"
        timeZone={zone}
        refresh={2}
        onEnded={() => {}}
      />,
    );
    await screen.findByText(
      "We emailed the link to their parent or guardian at n•••@example.test.",
    );
    expect(screen.queryByText(/^Sent again/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send again to Kit Minor" })).toBeTruthy();
  });

  it("never lets an earlier answer replace a later one", async () => {
    let releasePost: (r: Response) => void = () => {};
    const signedKit = {
      ...party,
      participants: party.participants.map((p) =>
        p.position === 2 ? { ...p, status: "signed" as const, sentTo: null } : p,
      ),
    };
    let reads = 0;
    stubApi((call) => {
      if (call.method === "POST") {
        return new Promise<Response>((resolve) => {
          releasePost = resolve;
        }) as unknown as Response;
      }
      reads += 1;
      return json(200, { waivers: reads === 1 ? party : signedKit });
    });
    const view = show({ refresh: 1 });
    await screen.findByText("1 of 3 signed");
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    // A read that starts after the send answers first: Kit has signed.
    view.rerender(
      <PartyWaivers
        session={session}
        operator="Demo Harbor Charters"
        timeZone={zone}
        refresh={2}
        onEnded={() => {}}
      />,
    );
    await screen.findByText("2 of 3 signed");
    // The send's older list arrives last and changes nothing shown.
    await act(async () => {
      releasePost(json(202, { waivers: party }));
    });
    await waitFor(() => expect(reads).toBe(3));
    expect(screen.getByText("2 of 3 signed")).toBeTruthy();
  });

  it("says when the booking site can't be reached, and the button stays", async () => {
    stubApi((call) => {
      if (call.method === "POST") throw new TypeError("offline");
      return json(200, { waivers: party });
    });
    show();
    await screen.findByText("1 of 3 signed");
    fireEvent.click(screen.getByRole("button", { name: "Send again to Kit Minor" }));
    await screen.findByText(
      "We couldn't reach the booking site. Check your connection, then try again.",
    );
    const button = screen.getByRole("button", { name: "Send again to Kit Minor" });
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("says what to do for each refusal", () => {
    const op = "Demo Reef Divers";
    expect(resendProblem("waiver_email_pending", 409, op)).toMatch(/still on its way/);
    expect(resendProblem("waiver_resend_limit", 409, op)).toBe(
      "This waiver has been sent as many times as we can for now. Contact Demo Reef Divers if it still hasn't arrived.",
    );
    expect(resendProblem("waiver_not_sent", 409, op)).toMatch(/Who's coming/);
    expect(resendProblem("waiver_trip_over", 409, op)).toMatch(/trip is over/);
    expect(resendProblem("waiver_resend_held", 409, op)).toBe(
      "We can't email this person again just yet. Try again later, or contact Demo Reef Divers.",
    );
    expect(resendProblem("waiver_participant_changed", 409, op)).toMatch(/party changed/);
    expect(resendProblem("rate_limited", 429, op)).toMatch(/Wait a minute/);
    expect(resendProblem("unknown", 503, op)).toMatch(/couldn't send it just now/);
    expect(resendProblem("unknown", 400, op)).toMatch(/contact Demo Reef Divers/);
  });
});
