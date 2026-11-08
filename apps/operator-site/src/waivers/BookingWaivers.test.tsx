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
      reminders: { sent: [], next: null },
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
          method: "email_link",
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
    expect(ann.getByText(/Signed .* by Ann Adult, from the emailed link\./)).toBeTruthy();
    // A signed waiver offers no dockside signing; a waiting one does.
    expect(ann.queryByRole("button", { name: /Sign here/ })).toBeNull();
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

  it("shows the reminder sent and the next one, and nothing for a signed waiver", async () => {
    const reminded: BookingWaivers = {
      ...waivers,
      participants: [
        waivers.participants[0] as ParticipantWaiver,
        participant(
          "Ben Waiting",
          "waiting",
          {
            reminders: {
              sent: [
                {
                  slot: "72h",
                  queuedAt: "2026-10-07T13:00:00.000Z",
                  state: "sent",
                  at: "2026-10-07T13:05:00.000Z",
                },
              ],
              next: { slot: "24h", at: "2026-10-09T13:00:00.000Z" },
            },
          },
          2,
        ),
      ],
    };
    stubApi(() => json(200, { waivers: reminded }));
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={bookingStaff}
        timeZone="America/New_York"
      />,
    );
    const ben = await screen.findByText(
      /^Reminder emailed .* \(3 days before\)\. Next reminder .* \(1 day before\)\.$/,
    );
    expect(ben).toBeTruthy();
    expect(screen.getAllByText(/Reminder/)).toHaveLength(1);
  });

  it("says no more reminders only once no email is on its way", async () => {
    const lastSent = {
      sent: [
        {
          slot: "24h" as const,
          queuedAt: "2026-10-08T13:00:00.000Z",
          state: "sent" as const,
          at: "2026-10-08T13:05:00.000Z",
        },
      ],
      next: null,
    };
    const resending = participant(
      "Ria Resent",
      "waiting",
      {
        reminders: lastSent,
        delivery: {
          generation: 2,
          kind: "resend",
          recipient: "r•••@example.test",
          queuedAt: "2026-10-08T15:00:00.000Z",
          sendAfter: "2026-10-08T15:00:00.000Z",
          message: { state: "queued", at: null, failureCode: null },
        },
      },
      2,
    );
    const settled = participant("Sol Settled", "waiting", { reminders: lastSent }, 3);
    stubApi(() =>
      json(200, {
        waivers: { ...waivers, participants: [resending, settled] },
      }),
    );
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={bookingStaff}
        timeZone="America/New_York"
      />,
    );
    const items = await screen.findAllByRole("listitem");
    expect(within(items[0] as HTMLElement).queryByText(/No more reminders/)).toBeNull();
    expect(
      within(items[1] as HTMLElement).getByText(/No more reminders before the trip/),
    ).toBeTruthy();
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

describe("signing at the dock", () => {
  const url = `https://demo-harbor.book.example.test/waiver#t=${"Q".repeat(43)}`;
  const answer = (path: string) =>
    path.endsWith("/assisted-signing")
      ? json(201, {
          signing: { mode: "participant_qr", url, expiresAt: "2026-10-06T16:15:00.000Z" },
        })
      : json(200, { waivers });

  it("needs the identity check first, then shows a QR code of the single-use link", async () => {
    const calls = stubApi(answer);
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={bookingStaff}
        timeZone="America/New_York"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Show QR code for Ben Waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Show QR code" }));
    await screen.findByText(/Check who is signing first/);
    expect(calls.filter((c) => c.url.endsWith("/assisted-signing"))).toEqual([]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "I checked that the person signing is Ben Waiting." }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show QR code" }));
    const qr = await screen.findByRole("img", { name: "QR code to sign Ben Waiting's waiver" });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M4 4h1v1h-1z/);
    const start = calls.find((c) => c.url.endsWith("/assisted-signing"));
    expect(start?.url).toBe(
      `/api/v1/staff/tenants/${tenantId}/waiver-requests/10000000-0000-4000-8000-000000000002/assisted-signing`,
    );
    expect(JSON.parse(String(start?.init?.body))).toEqual({
      mode: "participant_qr",
      identityChecked: true,
      participantName: "Ben Waiting",
    });
    // The link is drawn, never written out on the page.
    expect(document.body.textContent).not.toContain("Q".repeat(43));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/waivers"))).toHaveLength(2));
  });

  it("opens the signing page in a new tab with no referrer for signing on this device", async () => {
    stubApi(answer);
    render(
      <BookingWaiversCard
        tenantId={tenantId}
        bookingId={bookingId}
        role={owner}
        timeZone="America/New_York"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign here for Ben Waiting" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Start signing" }));
    const link = await screen.findByRole("link", {
      name: /^Open the signing page\s*\(opens in a new tab\)$/,
    });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // The link has focus, and Close is not the dialog's main button yet.
    await waitFor(() => expect(document.activeElement).toBe(link));
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    // Once opened, the used link is gone, so nobody opens it twice.
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(await screen.findByText("Opened in a new tab. The link works only once.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the signing page/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("explains a refusal and keeps the dialog open", async () => {
    stubApi((path) =>
      path.endsWith("/assisted-signing")
        ? json(409, { error: { code: "waiver_not_pending", message: "x", requestId: "r" } })
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
    fireEvent.click(await screen.findByRole("button", { name: "Sign here for Ben Waiting" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Start signing" }));
    await screen.findByText("This waiver no longer needs a signature.");
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
