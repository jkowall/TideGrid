import { describe, expect, it } from "vitest";
import {
  cloudflareEmailEvent,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_SENDING_DOMAIN,
} from "./cloudflare-events-fixture.ts";
import { emailEventsConfig, parseCloudflareEmailEvent } from "./events.ts";

const messageId = "0101018f7d0c4d9a-msg-deadbeef";

describe("parseCloudflareEmailEvent (W1-EMAIL-EVENTS)", () => {
  it("reads a hard bounce: ids, time, kind, and the enhanced status only", () => {
    const body = cloudflareEmailEvent("bounced", { messageId, eventId: "evt-hard-0001" });
    const parsed = parseCloudflareEmailEvent(body);
    expect(parsed).toEqual({
      kind: "parsed",
      event: {
        type: "bounced",
        eventId: "evt-hard-0001",
        accountId: FIXTURE_ACCOUNT_ID,
        domain: FIXTURE_SENDING_DOMAIN,
        messageId,
        occurredAt: new Date("2026-11-08T12:00:00.000Z"),
        terminal: true,
        bounceType: "hard",
        detailCode: "5.1.1",
      },
    });
    // Nothing personal survives the read: no address, subject, or SMTP text.
    expect(JSON.stringify(parsed)).not.toMatch(/example\.test|User unknown|confirmed/);
  });

  it("reads a soft bounce and a complaint", () => {
    const soft = parseCloudflareEmailEvent(
      cloudflareEmailEvent("bounced", { messageId, bounceType: "soft" }),
    );
    expect(soft).toMatchObject({ event: { bounceType: "soft", detailCode: "4.2.0" } });
    const complaint = parseCloudflareEmailEvent(cloudflareEmailEvent("complained", { messageId }));
    expect(complaint).toMatchObject({
      event: { type: "complained", bounceType: null, detailCode: "abuse" },
    });
  });

  it("reads the other four types, which the consumer then drops", () => {
    for (const type of ["delivered", "deferred", "failed", "rejected"] as const) {
      const parsed = parseCloudflareEmailEvent(cloudflareEmailEvent(type, { messageId }));
      expect(parsed).toMatchObject({ kind: "parsed", event: { type, bounceType: null } });
    }
  });

  it("refuses anything that is not a schema 1 Email Sending event", () => {
    const good = cloudflareEmailEvent("bounced", { messageId });
    const cases: [unknown, string][] = [
      [null, "not_an_object"],
      ["text", "not_an_object"],
      [[good], "not_an_object"],
      [{ ...good, type: "cf.email.routing.message.forwarded" }, "type_unknown"],
      [{ ...good, type: "cf.email.sending.message.opened" }, "type_unknown"],
      [{ ...good, source: { type: "email.routing", domain: "x.test" } }, "source_invalid"],
      [cloudflareEmailEvent("bounced", { messageId, schemaVersion: 2 }), "schema_version"],
      [{ ...good, metadata: { eventSchemaVersion: 1 } }, "metadata_invalid"],
      [cloudflareEmailEvent("bounced", { messageId, timestamp: "yesterday" }), "timestamp_invalid"],
      [cloudflareEmailEvent("bounced", { messageId, eventId: "short" }), "event_id_invalid"],
      [
        cloudflareEmailEvent("bounced", { messageId, eventId: "has space 123" }),
        "event_id_invalid",
      ],
      [cloudflareEmailEvent("bounced", { messageId: "" }), "message_id_invalid"],
      [
        cloudflareEmailEvent("bounced", {
          messageId: "cf_no_id.00000000-0000-4000-8000-000000000001",
        }),
        "message_id_stand_in",
      ],
      [
        cloudflareEmailEvent("bounced", { messageId, timestamp: "-271821-04-20T00:00:00.000Z" }),
        "timestamp_invalid",
      ],
      [
        cloudflareEmailEvent("bounced", { messageId, timestamp: "2200-01-01T00:00:00.000Z" }),
        "timestamp_invalid",
      ],
      [cloudflareEmailEvent("bounced", { messageId: "x".repeat(999) }), "message_id_invalid"],
    ];
    for (const [body, reason] of cases) {
      expect(parseCloudflareEmailEvent(body)).toEqual({ kind: "invalid", reason });
    }
  });

  it("drops a detail code that does not fit, rather than storing provider text", () => {
    const body = cloudflareEmailEvent("complained", { messageId });
    (body.payload as { complaint: { type: string } }).complaint.type = "not spam, see guest@x.test";
    expect(parseCloudflareEmailEvent(body)).toMatchObject({ event: { detailCode: null } });
  });

  it("compares the account and domain case-insensitively, without a trailing dot", () => {
    const body = cloudflareEmailEvent("bounced", {
      messageId,
      accountId: FIXTURE_ACCOUNT_ID.toUpperCase(),
      domain: `${FIXTURE_SENDING_DOMAIN.toUpperCase()}.`,
    });
    expect(parseCloudflareEmailEvent(body)).toMatchObject({
      event: { accountId: FIXTURE_ACCOUNT_ID, domain: FIXTURE_SENDING_DOMAIN },
    });
  });
});

describe("emailEventsConfig", () => {
  it("accepts a 32-hex account and a domain, and nothing else", () => {
    expect(
      emailEventsConfig(` ${FIXTURE_ACCOUNT_ID.toUpperCase()} `, "Mail.TideGrid.test."),
    ).toEqual({ accountId: FIXTURE_ACCOUNT_ID, sendingDomain: "mail.tidegrid.test" });
    expect(emailEventsConfig(undefined, "mail.tidegrid.test")).toBeNull();
    expect(emailEventsConfig("", "mail.tidegrid.test")).toBeNull();
    expect(emailEventsConfig("abc", "mail.tidegrid.test")).toBeNull();
    expect(emailEventsConfig(FIXTURE_ACCOUNT_ID, undefined)).toBeNull();
    expect(emailEventsConfig(FIXTURE_ACCOUNT_ID, "localhost")).toBeNull();
    expect(emailEventsConfig(FIXTURE_ACCOUNT_ID, "bad domain.test")).toBeNull();
  });
});
