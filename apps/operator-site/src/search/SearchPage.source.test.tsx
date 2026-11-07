// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Membership, StaffRole } from "@tidegrid/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  asSeenBy,
  json,
  membership,
  route,
  searchBody,
  searchResults,
  sentTo,
  strayRequests,
  tenantId,
  text,
} from "../bookings/fixtures.ts";
import { NavigationProvider } from "../navigation.tsx";
import { forgetSearches, recallSearch } from "./model.ts";
import { SearchPage } from "./SearchPage.tsx";

/** Search by source (G2.12): the Source control, the echo check, and the staff badge. */

const { maya, luis, priya } = searchResults;
const staffMaya = { ...maya, source: "staff_assisted" as const };
const directLuis = { ...luis, source: "direct" as const };

function renderPage(role: StaffRole = "owner", as?: Membership) {
  return render(
    <NavigationProvider navigate={vi.fn()}>
      <SearchPage membership={as ?? membership(role)} focusHeading={false} />
    </NavigationProvider>,
  );
}

const sourceField = () => screen.getByLabelText("Source") as HTMLSelectElement;
const textbox = () => screen.getByRole("textbox") as HTMLInputElement;
const searchButton = () => screen.getByRole("button", { name: "Search" });
const choose = (value: string) => fireEvent.change(sourceField(), { target: { value } });
const type = (value: string) => fireEvent.change(textbox(), { target: { value } });
const bodiesSent = () => sentTo(route.search()).map((sent) => sent.body);
const items = () => [...document.querySelectorAll<HTMLElement>("li.bs-item")];

const answer =
  (role: StaffRole, over: Parameters<typeof searchBody>[0] = {}) =>
  () =>
    json(
      asSeenBy(
        role,
        searchBody({ ...(role === "finance" ? { matchedOn: ["reference"] } : {}), ...over }),
      ),
    );

const staffAnswer = () =>
  answer("owner", { results: [staffMaya], total: 1, source: "staff_assisted" });

beforeEach(() => {
  window.history.replaceState(null, "", "/bookings/search");
  forgetSearches();
});

afterEach(() => {
  const strays = strayRequests();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetSearches();
  expect(strays).toEqual([]);
});

describe("the Source control", () => {
  it.each(["owner", "booking_staff", "finance"] as const)(
    "lets %s choose a source, and sends it only when chosen",
    async (role) => {
      api({
        [route.search()]: answer(role, {
          results: [staffMaya],
          total: 1,
          source: "staff_assisted",
        }),
      });
      renderPage(role);
      expect(sourceField().value).toBe("");
      expect([...sourceField().options].map((o) => o.label)).toEqual([
        "All sources",
        "Online, by the guest",
        "Staff bookings",
      ]);
      const q = role === "finance" ? "QKG6" : "maya";
      type(q);
      choose("staff_assisted");
      fireEvent.click(searchButton());
      await screen.findByRole("heading", { level: 2, name: "1 booking" });
      expect(bodiesSent()).toEqual([{ q, source: "staff_assisted", limit: 25 }]);
    },
  );

  it("leaves source out of the body when none is chosen", async () => {
    api({ [route.search()]: answer("owner") });
    renderPage();
    type("maya");
    fireEvent.click(searchButton());
    await screen.findByRole("heading", { level: 2, name: "2 bookings" });
    expect(bodiesSent()).toEqual([{ q: "maya", limit: 25 }]);
  });

  it("refuses a source alone with the text error, and asks nothing", () => {
    const calls = api({});
    renderPage();
    choose("direct");
    fireEvent.click(searchButton());
    expect(text(document.querySelector(".tg-field__error"))).toBe(
      "Enter a name, an email, or a booking reference, or choose dates. A source narrows a search.",
    );
    expect(calls).toEqual([]);
  });

  it("names the source in the results' terms", async () => {
    api({ [route.search()]: staffAnswer() });
    renderPage();
    type("maya");
    choose("staff_assisted");
    fireEvent.click(searchButton());
    await screen.findByRole("heading", { level: 2, name: "1 booking" });
    expect(text(document.body)).toContain("Staff bookings matching “maya”.");
  });

  it("clears the source with the rest, and remembers it in memory only", async () => {
    api({ [route.search()]: staffAnswer() });
    renderPage();
    type("maya");
    choose("staff_assisted");
    fireEvent.click(searchButton());
    await screen.findByRole("heading", { level: 2, name: "1 booking" });
    expect(recallSearch(tenantId)?.source).toBe("staff_assisted");
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(sourceField().value).toBe("");
    expect(recallSearch(tenantId)?.source).toBe("");
  });

  it("restores a remembered source when the page comes back", async () => {
    api({ [route.search()]: staffAnswer() });
    const first = renderPage();
    type("maya");
    choose("staff_assisted");
    fireEvent.click(searchButton());
    await screen.findByRole("heading", { level: 2, name: "1 booking" });
    first.unmount();
    renderPage();
    expect(sourceField().value).toBe("staff_assisted");
    expect(window.location.search).toBe("");
  });

  it("asks again when only the source changes", async () => {
    api({
      [route.search()]: [
        staffAnswer(),
        answer("owner", { results: [directLuis], total: 1, source: "direct" }),
      ],
    });
    renderPage();
    type("maya");
    choose("staff_assisted");
    fireEvent.click(searchButton());
    await screen.findByRole("heading", { level: 2, name: "1 booking" });
    choose("direct");
    fireEvent.click(searchButton());
    await vi.waitFor(() => expect(bodiesSent()).toHaveLength(2));
    expect(bodiesSent()[1]).toEqual({ q: "maya", source: "direct", limit: 25 });
  });
});

describe("the answer's echo", () => {
  it.each([
    ["a filtered search answered without the source", undefined],
    ["a filtered search answered unfiltered", null],
    ["a filtered search answered for the other source", "direct"],
  ])("shows %s as unreadable", async (_what, echoed) => {
    api({ [route.search()]: () => json({ ...searchBody(), source: echoed }) });
    renderPage();
    type("maya");
    choose("staff_assisted");
    fireEvent.click(searchButton());
    const alert = await screen.findByRole("alert");
    expect(text(alert)).toContain("TideGrid sent something this console can't read.");
    expect(items()).toEqual([]);
  });

  it.each([
    ["no source", undefined],
    ["a null source", null],
  ])("accepts an unfiltered search answered with %s", async (_what, echoed) => {
    api({ [route.search()]: () => json({ ...searchBody(), source: echoed }) });
    renderPage();
    type("maya");
    fireEvent.click(searchButton());
    await screen.findByRole("heading", { level: 2, name: "2 bookings" });
  });

  it("refuses an unfiltered search answered with a source", async () => {
    api({ [route.search()]: () => json({ ...searchBody(), source: "direct" }) });
    renderPage();
    type("maya");
    fireEvent.click(searchButton());
    expect(text(await screen.findByRole("alert"))).toContain("can't read");
  });
});

describe("the staff badge", () => {
  it.each(["owner", "booking_staff", "finance"] as const)(
    "shows on a staff booking for %s, and on nothing else",
    async (role) => {
      api({
        [route.search()]: answer(role, {
          results: [staffMaya, directLuis, { ...priya, source: "imported" as never }],
          total: 3,
        }),
      });
      renderPage(role);
      type(role === "finance" ? "QKG6" : "maya");
      fireEvent.click(searchButton());
      await screen.findByRole("heading", { level: 2, name: "3 bookings" });
      const [first, second, third] = items();
      expect(text(first?.querySelector(".bk-badges"))).toContain("Source: Staff booking");
      expect(text(second?.querySelector(".bk-badges"))).not.toContain("Source");
      expect(text(third?.querySelector(".bk-badges"))).not.toContain("Source");
    },
  );
});
