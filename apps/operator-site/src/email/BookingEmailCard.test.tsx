// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BookingEmailResendBlock, StaffRole } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEmailCard } from "./BookingEmailCard.tsx";
import {
  apiError,
  availability,
  bookerEmail,
  bookingId,
  json,
  message,
  messagesBody,
  messagesPath,
  resendPath,
  type Sent,
  stubApi,
  tenantId,
  text,
} from "./fixtures.ts";
import { resendFailureText } from "./model.ts";

function renderCard(role: StaffRole = "owner") {
  return render(
    <BookingEmailCard
      tenantId={tenantId}
      bookingId={bookingId}
      role={role}
      timeZone="America/New_York"
      bookerEmail={bookerEmail}
    />,
  );
}

const card = () => screen.getByRole("region", { name: "Email" });
/** The card has its answer: request lists compare only after this. */
const settled = () => waitFor(() => expect(card().getAttribute("aria-busy")).toBe("false"));
const items = () => within(card()).queryAllByRole("listitem");
const reads = (calls: Sent[]) => calls.filter((c) => c.method === "GET" && c.path === messagesPath);
const sends = (calls: Sent[]) => calls.filter((c) => c.method === "POST" && c.path === resendPath);

beforeEach(() => {
  // Two days before the emails, so their day reads as a weekday and a date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T17:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a booking's email (G2.16b)", () => {
  it("lists the booking's own email oldest first, each state an icon and a label, and leaves waiver email out", async () => {
    stubApi(() =>
      json(
        200,
        messagesBody({
          messages: [
            message({
              state: "failed",
              sentAt: null,
              failedAt: "2026-11-04T14:00:03.000Z",
              failureCode: "outcome_unknown",
            }),
            message({ template: "waiver_request" }),
            message({ staffResend: true, createdAt: "2026-11-04T15:00:00.000Z" }),
            message({
              template: "booking_manage_link",
              state: "queued",
              attempts: 0,
              sentAt: null,
              lastAttemptAt: null,
              nextAttemptAt: "2026-11-04T15:05:00.000Z",
            }),
          ],
        }),
      ),
    );
    renderCard();
    await settled();
    const rows = items();
    expect(rows.map((row) => text(row.querySelector(".em-item__name")))).toEqual([
      "Confirmation",
      "Confirmation, Sent again by staff",
      "Booking link",
    ]);
    expect(rows.map((row) => text(row.querySelector(".tg-status")))).toEqual([
      "Outcome unknown",
      "Sent",
      "Waiting to send",
    ]);
    // Every badge carries an icon beside its words.
    for (const badge of card().querySelectorAll(".tg-status")) {
      expect(badge.querySelector("svg")).not.toBeNull();
    }
    expect(text(rows[0])).toContain(
      "The email service did not answer, so TideGrid did not try again, to avoid a second working link. Send it again if the guest did not get it.",
    );
    expect(text(rows[0])).toContain("after 1 attempt");
    expect(text(rows[1])).toContain(
      "Accepted by the email service Wed, Nov 4, 9:00 AM EST. That doesn't mean the guest read it.",
    );
    // No recipient, subject, or body: the API sends none, and the card shows none.
    expect(text(card())).not.toContain("@");
  });

  it("shows a code it does not know in generic words and still renders", async () => {
    stubApi(() =>
      json(
        200,
        messagesBody({
          messages: [
            message({ state: "failed", sentAt: null, failureCode: "carrier_pigeon_lost" }),
          ],
        }),
      ),
    );
    renderCard();
    await settled();
    expect(text(items()[0])).toContain(
      "The email service reported a problem TideGrid doesn't describe yet.",
    );
    expect(text(card())).not.toContain("carrier");
  });

  it("says so while it loads, and settles", async () => {
    let answer: (r: Response) => void = () => {};
    stubApi(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderCard();
    expect(card().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading email…");
    answer(json(200, messagesBody()));
    await settled();
    expect(items()).toHaveLength(1);
  });

  it("says when there is no email yet", async () => {
    stubApi(() => json(200, messagesBody({ messages: [] })));
    renderCard();
    await settled();
    expect(within(card()).getByText("No email for this booking yet.")).toBeTruthy();
  });

  it("shows a designed error with Try again, then the email, and hands focus to the card's heading", async () => {
    let first = true;
    const calls = stubApi(() => {
      if (first) {
        first = false;
        return apiError(500, "internal_error");
      }
      return json(200, messagesBody());
    });
    renderCard();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("Email didn't load");
    const retry = within(alert).getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(items()).toHaveLength(1));
    await settled();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Email" }));
    expect(reads(calls)).toHaveLength(2);
  });

  it("says email is off here, keeps the queue visible, and offers no Send again", async () => {
    stubApi(() =>
      json(
        200,
        messagesBody({
          emailDelivery: "off",
          messages: [message({ state: "queued", attempts: 0, sentAt: null, lastAttemptAt: null })],
          resend: availability({ allowed: false, blockedBy: "email_off" }),
        }),
      ),
    );
    renderCard("owner");
    await settled();
    expect(text(card())).toContain("Email is off here");
    expect(text(items()[0])).toContain("Email is off here, so it waits.");
    expect(within(card()).queryByRole("button")).toBeNull();
  });

  const blocks: [Exclude<BookingEmailResendBlock, "email_off">, string | null, RegExp][] = [
    ["kind_mismatch", null, /no email of that kind/],
    ["trip_over", null, /The trip has ended/],
    ["refund_failed", null, /The refund failed.*Contact the guest directly\./],
    ["limit", null, /sent again 5 times/],
    ["too_soon", "2026-11-04T20:10:00.000Z", /It can be sent again from Wed, Nov 4, 3:10 PM EST\./],
    ["rate_limited", "2026-11-04T20:40:00.000Z", /50 emails again.*from Wed, Nov 4, 3:40 PM EST\./],
    ["in_progress", null, /being sent right now/],
  ];

  it.each(blocks)("says why Send again is not offered: %s", async (blockedBy, at, words) => {
    stubApi(() =>
      json(
        200,
        messagesBody({
          resend: availability({ allowed: false, blockedBy, availableAt: at, remaining: 3 }),
        }),
      ),
    );
    renderCard("booking_staff");
    await settled();
    expect(text(card().querySelector(".em-resend"))).toMatch(words);
    expect(within(card()).queryByRole("button")).toBeNull();
  });

  it("gives a role without messages.resend the list and no Send again", async () => {
    stubApi(() => json(200, messagesBody()));
    renderCard("finance");
    await settled();
    expect(items()).toHaveLength(1);
    expect(within(card()).queryByRole("button")).toBeNull();
  });
});

describe("sending it again (G2.16b)", () => {
  it("asks for a reason, shows the address to read back, and sends the kind and reason with a key, never an address", async () => {
    let sent = false;
    const calls = stubApi((call) => {
      if (call.method === "POST") {
        sent = true;
        return json(201, {
          message: {
            id: "99999999-0000-4000-8000-000000000001",
            generation: 1,
            queuedAt: "2026-11-04T19:00:00.000Z",
          },
        });
      }
      return json(
        200,
        sent
          ? messagesBody({
              messages: [message(), message({ staffResend: true, state: "queued", sentAt: null })],
              resend: availability({
                allowed: false,
                blockedBy: "too_soon",
                availableAt: "2026-11-04T19:10:00.000Z",
                remaining: 4,
              }),
            })
          : messagesBody(),
      );
    });
    renderCard();
    await settled();
    expect(text(card())).toContain("5 of 5 sends again left for this booking.");
    fireEvent.click(within(card()).getByRole("button", { name: "Send the confirmation again" }));
    const dialog = await screen.findByRole("dialog", { name: "Send the confirmation again" });
    expect(text(dialog)).toContain(
      `A new email goes to ${bookerEmail}, the address on the booking.`,
    );
    expect(document.activeElement).toBe(within(dialog).getByLabelText(/Reason/));

    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    expect(text(dialog)).toContain("Choose why it is being sent again; the history records it");
    expect(sends(calls)).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "delivery_unknown" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    const notice = await screen.findByText("Queued to send again");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(text(card())).toContain(
      `A new confirmation is queued for ${bookerEmail}. The list above shows whether the email service took it.`,
    );
    expect(document.activeElement?.contains(notice)).toBe(true);

    const [post] = sends(calls);
    expect(post?.body).toEqual({ kind: "confirmation", reason: "delivery_unknown" });
    expect(JSON.stringify(post?.body)).not.toContain("@");
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{32,36}$/);
    await waitFor(() => expect(reads(calls)).toHaveLength(2));
    await settled();
    expect(text(card().querySelector(".em-resend"))).toContain("It can be sent again from");
  });

  it("offers the cancellation notice for a canceled booking", async () => {
    const calls = stubApi((call) =>
      call.method === "POST"
        ? json(201, {
            message: {
              id: "99999999-0000-4000-8000-000000000002",
              generation: 2,
              queuedAt: "2026-11-04T19:00:00.000Z",
            },
          })
        : json(
            200,
            messagesBody({
              messages: [message({ template: "booking_canceled" })],
              resend: availability({ kind: "cancellation", remaining: 1 }),
            }),
          ),
    );
    renderCard("booking_staff");
    await settled();
    fireEvent.click(
      within(card()).getByRole("button", { name: "Send the cancellation notice again" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(text(dialog)).toContain("This is the last send again for this booking.");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "guest_asked_again" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    await screen.findByText("Queued to send again");
    expect(sends(calls)[0]?.body).toEqual({ kind: "cancellation", reason: "guest_asked_again" });
  });

  it("keeps the key after no answer, and takes a new one after the API decided", async () => {
    let posts = 0;
    const calls = stubApi((call) => {
      if (call.method !== "POST") return json(200, messagesBody());
      posts += 1;
      if (posts === 1) throw new TypeError("Failed to fetch");
      if (posts === 2) return apiError(409, "booking_email_too_soon");
      return json(201, {
        message: {
          id: "99999999-0000-4000-8000-000000000003",
          generation: 1,
          queuedAt: "2026-11-04T19:00:00.000Z",
        },
      });
    });
    renderCard();
    await settled();
    fireEvent.click(within(card()).getByRole("button", { name: "Send the confirmation again" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "guest_did_not_receive" },
    });
    const send = () => fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    send();
    await within(dialog).findByText(resendFailureText("unreachable"));
    send();
    await within(dialog).findByText(resendFailureText("too_soon"));
    send();
    await screen.findByText("Queued to send again");
    const keys = sends(calls).map((c) => c.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  const refusals: [string, string][] = [
    ["booking_email_off", "email_off"],
    ["booking_email_kind_mismatch", "kind_mismatch"],
    ["booking_trip_over", "trip_over"],
    ["booking_email_refund_failed", "refund_failed"],
    ["booking_email_resend_limit", "limit"],
    ["booking_email_too_soon", "too_soon"],
    ["booking_email_rate_limited", "rate_limited"],
    ["booking_email_in_progress", "in_progress"],
    ["booking_email_invalid", "email_invalid"],
  ];

  it.each(refusals)(
    "explains a %s refusal in the dialog and keeps it open",
    async (code, reason) => {
      stubApi((call) => (call.method === "POST" ? apiError(409, code) : json(200, messagesBody())));
      renderCard();
      await settled();
      fireEvent.click(within(card()).getByRole("button", { name: "Send the confirmation again" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "other" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
      expect(text(await within(dialog).findByRole("alert"))).toContain(resendFailureText(reason));
      expect(screen.getByRole("dialog")).toBeTruthy();
    },
  );

  it("opens the dialog when Send again is pressed between a commit and its passive effects", async () => {
    // A native click from a MutationObserver callback runs after React
    // commits the button and before that commit's passive effects flush: the
    // order a preempted CI runner produces. The dialog must still open, take
    // focus, and send.
    const calls = stubApi((call) =>
      call.method === "POST"
        ? json(201, {
            message: {
              id: "99999999-0000-4000-8000-000000000004",
              generation: 1,
              queuedAt: "2026-11-04T19:00:00.000Z",
            },
          })
        : json(200, messagesBody()),
    );
    let pressed = false;
    const observer = new MutationObserver(() => {
      if (pressed) return;
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Send the confirmation again",
      );
      if (button) {
        pressed = true;
        button.click();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      renderCard();
      const dialog = await screen.findByRole("dialog", { name: "Send the confirmation again" });
      expect(pressed).toBe(true);
      expect(document.activeElement).toBe(within(dialog).getByLabelText(/Reason/));
      fireEvent.change(within(dialog).getByLabelText(/Reason/), {
        target: { value: "guest_did_not_receive" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
      await screen.findByText("Queued to send again");
      expect(sends(calls)).toHaveLength(1);
    } finally {
      observer.disconnect();
    }
  });
});

describe("the review's fixes (G2.16b fix round)", () => {
  const created = (id: string) =>
    json(201, { message: { id, generation: 1, queuedAt: "2026-11-04T19:00:00.000Z" } });

  async function openDialog(reason: string) {
    fireEvent.click(within(card()).getByRole("button", { name: "Send the confirmation again" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
    return dialog;
  }

  it("takes a new key when the reason changes after no answer, so the server's answer is the truth", async () => {
    let posts = 0;
    const calls = stubApi((call) => {
      if (call.method !== "POST") return json(200, messagesBody());
      posts += 1;
      // The first send went through; its answer was lost.
      if (posts === 1) throw new TypeError("Failed to fetch");
      return apiError(409, "booking_email_too_soon");
    });
    renderCard();
    await settled();
    const dialog = await openDialog("guest_did_not_receive");
    const send = () => fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    send();
    await within(dialog).findByText(resendFailureText("unreachable"));
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "other" } });
    send();
    await within(dialog).findByText(resendFailureText("too_soon"));
    const [first, second] = sends(calls);
    expect(second?.body).toEqual({ kind: "confirmation", reason: "other" });
    expect(second?.headers.get("Idempotency-Key")).not.toBe(first?.headers.get("Idempotency-Key"));
  });

  it("reads a reused key as an earlier try that may have gone through, and reads the card again", async () => {
    const calls = stubApi((call) =>
      call.method === "POST" ? apiError(422, "idempotency_key_reused") : json(200, messagesBody()),
    );
    renderCard();
    await settled();
    const dialog = await openDialog("other");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain(resendFailureText("key_reused"));
    expect(resendFailureText("key_reused")).toMatch(/may have gone through/);
    await waitFor(() => expect(reads(calls)).toHaveLength(2));
  });

  it("reads the card again after a final refusal, so what it offers is current", async () => {
    const calls = stubApi((call) =>
      call.method === "POST" ? apiError(409, "booking_email_too_soon") : json(200, messagesBody()),
    );
    renderCard();
    await settled();
    const dialog = await openDialog("other");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    await within(dialog).findByText(resendFailureText("too_soon"));
    await waitFor(() => expect(reads(calls)).toHaveLength(2));
  });

  it("says the email is queued, not on its way, and leaves delivery to the list", async () => {
    let sent = false;
    const failed = "99999999-0000-4000-8000-000000000010";
    stubApi((call) => {
      if (call.method === "POST") {
        sent = true;
        return created(failed);
      }
      return json(
        200,
        sent
          ? messagesBody({
              messages: [
                message(),
                message({
                  id: failed,
                  staffResend: true,
                  state: "failed",
                  sentAt: null,
                  failedAt: "2026-11-04T19:00:05.000Z",
                  failureCode: "bounced",
                }),
              ],
              resend: availability({ allowed: false, blockedBy: "too_soon" }),
            })
          : messagesBody(),
      );
    });
    renderCard();
    await settled();
    const dialog = await openDialog("delivery_failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    await screen.findByText("Queued to send again");
    await waitFor(() => expect(text(items()[1])).toContain("Failed"));
    const notice = text(card().querySelector(".em-sent"));
    expect(notice).toContain("is queued for");
    expect(notice).toContain("The list above shows whether the email service took it.");
    expect(notice).not.toMatch(/on its way|Sent again/);
  });

  it("says earlier links stop working once TideGrid starts sending it, even if that send fails", async () => {
    stubApi(() => json(200, messagesBody()));
    renderCard();
    await settled();
    const dialog = await openDialog("other");
    expect(text(dialog)).toContain(
      "Links in earlier emails stop working once TideGrid starts sending it, even if that send fails; the guest can still ask for a new link from one.",
    );
  });

  it("hands focus to the heading when Try again's answer commits, before passive effects run", async () => {
    // The list item appears in the commit that ends Try again. A MutationObserver
    // callback runs after that commit and before its passive effects flush, the
    // order a preempted CI runner produces: focus must have moved already.
    let first = true;
    stubApi(() => {
      if (first) {
        first = false;
        return apiError(500, "internal_error");
      }
      return json(200, messagesBody());
    });
    renderCard();
    const retry = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    let focusedWhenListed: Element | null | undefined;
    const observer = new MutationObserver(() => {
      if (focusedWhenListed === undefined && document.querySelector(".em-item")) {
        focusedWhenListed = document.activeElement;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      retry.focus();
      fireEvent.click(retry);
      await waitFor(() => expect(focusedWhenListed).toBeDefined());
    } finally {
      observer.disconnect();
    }
    expect(focusedWhenListed).toBe(screen.getByRole("heading", { name: "Email" }));
  });

  it("asks a signed-out person to sign in again, with no Try again", async () => {
    stubApi(() => apiError(401, "unauthenticated"));
    renderCard();
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("You're signed out. Sign in again to see this booking's email.");
    expect(within(alert).queryByRole("button")).toBeNull();
    // The console's own way back: this page again, which asks for a sign-in first.
    expect(within(alert).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
      window.location.pathname,
    );
  });
});

describe("focus after the card changes under it (G2.16b final check)", () => {
  const heading = () => screen.getByRole("heading", { name: "Email" });

  it("hands focus to the heading when the dialog closes after a refusal took its opener away", async () => {
    let refused = false;
    stubApi((call) => {
      if (call.method === "POST") {
        refused = true;
        return apiError(409, "booking_email_too_soon");
      }
      return json(
        200,
        refused
          ? messagesBody({
              resend: availability({
                allowed: false,
                blockedBy: "too_soon",
                availableAt: "2026-11-04T19:10:00.000Z",
                remaining: 4,
              }),
            })
          : messagesBody(),
      );
    });
    renderCard();
    await settled();
    const opener = within(card()).getByRole("button", { name: "Send the confirmation again" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "other" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    await within(dialog).findByText(resendFailureText("too_soon"));
    // The re-read after the refusal takes Send again away while the dialog is open.
    await waitFor(() =>
      expect(
        within(card()).queryByRole("button", { name: "Send the confirmation again" }),
      ).toBeNull(),
    );
    await settled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it("hands focus to the heading when a re-read takes away the Send again that had it", async () => {
    let answer: (r: Response) => void = () => {};
    let reads = 0;
    stubApi((call) => {
      if (call.method === "POST") return apiError(409, "booking_email_rate_limited");
      reads += 1;
      if (reads === 1) return json(200, messagesBody());
      // The re-read after the refusal lands only after the dialog has closed.
      return new Promise<Response>((resolve) => (answer = resolve));
    });
    renderCard();
    await settled();
    const opener = within(card()).getByRole("button", { name: "Send the confirmation again" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "other" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send again" }));
    await within(dialog).findByText(resendFailureText("rate_limited"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
    answer(
      json(
        200,
        messagesBody({ resend: availability({ allowed: false, blockedBy: "rate_limited" }) }),
      ),
    );
    await settled();
    expect(opener.isConnected).toBe(false);
    expect(document.activeElement).toBe(heading());
  });

  it("hands focus to the heading when Try again ends signed out and its button goes", async () => {
    let first = true;
    stubApi(() => {
      if (first) {
        first = false;
        return apiError(500, "internal_error");
      }
      return apiError(401, "unauthenticated");
    });
    renderCard();
    const retry = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByText("You're signed out. Sign in again to see this booking's email.");
    await settled();
    expect(within(card()).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.activeElement).toBe(heading());
  });
});
