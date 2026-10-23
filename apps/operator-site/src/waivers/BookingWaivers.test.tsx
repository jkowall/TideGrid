// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BookingWaivers, ParticipantWaiver, StaffRole } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingWaiversCard } from "./BookingWaivers.tsx";
import { TripWaiversCard } from "./TripWaivers.tsx";

const tenantId = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
const bookingId = "11111111-2222-4333-8444-555555555555";
const tripId = "a99737eb-69c6-4c43-a430-a33aa4740556";
const owner: StaffRole = "owner";
const bookingStaff: StaffRole = "booking_staff";

function participant(
  name: string,
  status: ParticipantWaiver["status"],
  overrides: Partial<NonNullable<ParticipantWaiver["request"]>> = {},
  position = 1,
): ParticipantWaiver {
  return {
    participantId: `00000000-0000-4000-8000-00000000000${position}`,
    position,
    name,
    minor: false,
    status,
    request: {
      id: `10000000-0000-4000-8000-00000000000${position}`,
      state: status === "signed" ? "signed" : "pending",
      revokedReason: null,
      requiredSigner: "participant",
      templateName: "Harbor participation waiver",
      version: 1,
      assignedAt: "2026-10-06T14:00:00.000Z",
      signed: null,
      delivery: {
        generation: 1,
        kind: "initial",
        recipient: "a•••@example.test",
        queuedAt: "2026-10-06T14:00:00.000Z",
        sendAfter: "2026-10-06T14:00:00.000Z",
        message: { state: "sent", at: "2026-10-06T14:00:05.000Z", failureCode: null },
      },
      resendAvailableAt: "2026-10-06T14:10:00.000Z",
      ...overrides,
    },
  };
}

const waivers: BookingWaivers = {
  bookingId,
  reference: "7KQ2M9XA",
  bookingState: "confirmed",
  partySize: 3,
  required: true,
  unnamedPlaces: 1,
  participants: [
    participant(
      "Ann Adult",
      "signed",
      {
        signed: {
          evidenceId: "20000000-0000-4000-8000-000000000001",
          signedAt: "2026-10-06T15:00:00.000Z",
          signerName: "Ann Adult",
          relationship: null,
        },
        resendAvailableAt: null,
      },
      1,
    ),
    participant("Ben Waiting", "waiting", {}, 2),
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubApi(answer: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return answer(String(input), init);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a booking's waivers", () => {
  it("shows each person's status as an icon and a label, the signed PDF, and the email apart", async () => {
    stubApi(() => json(200, { waivers }));
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={bookingStaff}
        timeZone="America/New_York"
      />,
    );
    await screen.findByText("1 of 2 named people have signed. 1 place is not named yet.");
    const items = screen.getAllByRole("listitem");
    const ann = within(items[0] as HTMLElement);
    expect(ann.getByText("Signed")).toBeTruthy();
    expect(ann.getByText(/Signed .* by Ann Adult\./)).toBeTruthy();
    expect(ann.getByRole("link", { name: "Signed PDF for Ann Adult" }).getAttribute("href")).toBe(
      `/api/v1/staff/tenants/${tenantId}/waiver-evidence/20000000-0000-4000-8000-000000000001/document`,
    );
    const ben = within(items[1] as HTMLElement);
    expect(ben.getByText("Waiting for signature")).toBeTruthy();
    expect(ben.getByText("Email sent to a•••@example.test")).toBeTruthy();
    // Every badge carries an icon beside its words.
    for (const badge of document.querySelectorAll(".tg-status")) {
      expect(badge.querySelector("svg")).not.toBeNull();
      expect(badge.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("sends a request again with a reason and a key, and reloads", async () => {
    const calls = stubApi((url) =>
      url.endsWith("/resend")
        ? json(201, { delivery: { generation: 2, queuedAt: "2026-10-06T16:00:00.000Z" } })
        : json(200, { waivers }),
    );
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={owner}
        timeZone="America/New_York"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send again to Ben Waiting" }));
    const reason = screen.getByLabelText("Reason");
    fireEvent.change(reason, { target: { value: "Guest deleted the email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await screen.findByText("Sent again");
    const resend = calls.find((c) => c.url.endsWith("/resend"));
    expect(resend?.url).toBe(
      `/api/v1/staff/tenants/${tenantId}/waiver-requests/10000000-0000-4000-8000-000000000002/resend`,
    );
    expect(JSON.parse(String(resend?.init?.body))).toEqual({ reason: "Guest deleted the email" });
    expect(new Headers(resend?.init?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{32,36}$/);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/waivers"))).toHaveLength(2));
  });

  it("explains a refused resend in the dialog and keeps it open", async () => {
    stubApi((url) =>
      url.endsWith("/resend")
        ? json(409, { error: { code: "waiver_resend_limit", message: "x", requestId: "r" } })
        : json(200, { waivers }),
    );
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={owner}
        timeZone="America/New_York"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send again to Ben Waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await screen.findByText("It has been sent 5 times, the most a waiver request can be.");
  });

  it("sends a refused resend's next try with a new key, and a lost answer's with the same", async () => {
    let answers = [
      () =>
        json(409, { error: { code: "waiver_resend_rate_limited", message: "x", requestId: "r" } }),
      () => json(503, { error: { code: "unavailable", message: "x", requestId: "r" } }),
      () => json(201, { delivery: { generation: 2, queuedAt: "2026-10-06T16:00:00.000Z" } }),
    ];
    const calls = stubApi((url) => {
      if (!url.endsWith("/resend")) return json(200, { waivers });
      const [next, ...rest] = answers;
      answers = rest;
      return (next ?? answers[0] ?? (() => json(500, {})))();
    });
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={owner}
        timeZone="America/New_York"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send again to Ben Waiting" }));
    const send = () => fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    send();
    await screen.findByText(/has reached its sending limit for now/);
    send();
    await screen.findByText("TideGrid didn't send it. Try again in a moment.");
    send();
    // The notice sits under the person who was sent again.
    const items = await screen.findAllByRole("listitem");
    await within(items[1] as HTMLElement).findByText("Sent again");
    const keys = calls
      .filter((c) => c.url.endsWith("/resend"))
      .map((c) => new Headers(c.init?.headers).get("Idempotency-Key"));
    expect(keys).toHaveLength(3);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });

  it("says why a held email has no working link, and names a minor apart from the tag", async () => {
    stubApi(() =>
      json(200, {
        waivers: {
          ...waivers,
          participants: [
            { ...participant("Hal Held", "email_held", {}, 1), minor: true },
            participant("Ben Waiting", "waiting", {}, 2),
          ],
        },
      }),
    );
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={owner}
        timeZone="America/New_York"
      />,
    );
    const [hal] = await screen.findAllByRole("listitem");
    const row = within(hal as HTMLElement);
    expect(row.getByText("Email on hold")).toBeTruthy();
    expect(row.getByText(/has no working link yet/)).toBeTruthy();
    expect((hal as HTMLElement).querySelector(".wv-item__name")?.textContent).toBe(
      "Hal Held, Minor",
    );
  });
});

describe("a trip's waivers", () => {
  it("totals the trip and lists each booking's people with their status", async () => {
    stubApi(() =>
      json(200, {
        tripId,
        bookings: [waivers],
        totals: { participants: 2, signed: 1, waiting: 1, attention: 0, unnamed: 1 },
      }),
    );
    render(<TripWaiversCard tenantId={tenantId} tripId={tripId} />);
    await screen.findByText("Booking 7KQ2M9XA");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("Ben Waiting")).toBeTruthy();
    expect(screen.getAllByText("Waiting for signature")).toHaveLength(1);
  });
});
