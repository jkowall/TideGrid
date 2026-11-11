// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImportantLink, StaffRole } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { membership } from "../bookings/fixtures.ts";
import { routeOf } from "../ConsoleShell.tsx";
import { NavigationProvider } from "../navigation.tsx";
import { formProblems, LinksPage, shownOn } from "./LinksPage.tsx";

const tenantId = membership("owner").tenantId;
const base = `/api/v1/staff/tenants/${tenantId}`;
const reef = "6a1c3e5b-0d8f-4c42-9b7a-1f2e3d4c5b6a";
const sunset = "7b2d4f6c-1e9a-4d53-8c8b-2a3f4e5d6c7b";

const link = (over: Partial<ImportantLink> = {}): ImportantLink => ({
  id: "9c3e5a7d-2f0b-4e64-9d9c-3b4a5f6e7d8c",
  label: "Fishing license",
  url: "https://license.example.org/apply",
  host: "license.example.org",
  description: "Needed for every angler over 16",
  productIds: null,
  position: 0,
  status: "active",
  updatedAt: "2026-11-11T12:00:00.000Z",
  ...over,
});

interface Sent {
  path: string;
  method: string;
  key: string | null;
  body: unknown;
}

function stub(links: ImportantLink[], answers: Record<string, () => Response> = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      sent.push({
        path: input,
        method,
        key: headers.get("Idempotency-Key"),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      const answer = answers[`${method} ${input}`];
      if (answer) return answer();
      if (input === `${base}/important-links`) return Response.json({ links });
      if (input === `${base}/catalog`) {
        return Response.json({
          locations: [],
          boats: [],
          products: [
            { id: reef, name: "Reef snorkel" },
            { id: sunset, name: "Sunset cruise" },
          ],
          schedules: [],
        });
      }
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    }),
  );
  return sent;
}

function renderPage(role: StaffRole = "owner") {
  render(
    <NavigationProvider navigate={vi.fn()}>
      <LinksPage membership={membership(role)} focusHeading={false} />
    </NavigationProvider>,
  );
}

const loaded = () => waitFor(() => expect(document.querySelector(".links-skeleton")).toBeNull());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Important links in the console (W3-G2.14b-rest)", () => {
  it("is the console page at /links", () => {
    expect(routeOf("/links")).toEqual({ kind: "links" });
  });

  it("lists active links by position with the site each opens and where it shows", async () => {
    stub([
      link({ id: "a", label: "Parking map", position: 2, productIds: [reef] }),
      link({ id: "b", label: "Fishing license", position: 1 }),
      link({ id: "c", label: "Old map", status: "archived" }),
    ]);
    renderPage();
    await loaded();
    const list = screen.getByRole("list", { name: "Links guests see, in order" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.querySelector(".links-item__title")?.textContent)).toEqual([
      "Fishing license",
      "Parking map",
    ]);
    expect(items[0]?.textContent).toContain("Opens license.example.org");
    expect(items[0]?.textContent).toContain("Shows on: Every trip");
    expect(items[1]?.textContent).toContain("Shows on: Reef snorkel");
    expect(screen.getByText(/Archived links \(1\)/)).toBeTruthy();
  });

  it("lets only owners change links", async () => {
    stub([link()]);
    renderPage("booking_staff");
    await loaded();
    expect(screen.queryByRole("button", { name: "Add a link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.getByText(/Only owners change these links/)).toBeTruthy();
  });

  it("adds a link for chosen trips with one key, and shows it", async () => {
    const saved = link({ id: "new", label: "Parking map", productIds: [sunset], position: 1 });
    const sent = stub([link()], {
      [`POST ${base}/important-links`]: () => Response.json({ link: saved }, { status: 201 }),
    });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add a link" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Parking map " } });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://maps.example.org/dock" },
    });
    fireEvent.click(screen.getByLabelText("Every trip"));
    fireEvent.click(screen.getByLabelText("Sunset cruise"));
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    await waitFor(() => expect(screen.getByText("Added Parking map.")).toBeTruthy());
    const post = sent.find((s) => s.method === "POST");
    expect(post?.body).toEqual({
      label: "Parking map",
      url: "https://maps.example.org/dock",
      description: null,
      productIds: [sunset],
      position: 1,
    });
    expect(post?.key).toBeTruthy();
    expect(screen.getAllByText(/Parking map/).length).toBeGreaterThan(0);
  });

  it("checks the form before sending and names each problem", async () => {
    const sent = stub([]);
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add a link" }));
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://printer.local/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect(screen.getByText("Give the link a name.")).toBeTruthy();
    expect(screen.getByText(/not an IP address, a local name/)).toBeTruthy();
    expect(sent.some((s) => s.method === "POST")).toBe(false);
  });

  it("says when the operator is at its limit", async () => {
    const sent = stub([link()], {
      [`POST ${base}/important-links`]: () =>
        Response.json(
          { error: { code: "important_links_limit", message: "full" } },
          { status: 409 },
        ),
    });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add a link" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "One more" } });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://example.org/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    await waitFor(() => expect(screen.getByText(/at most 25 links/)).toBeTruthy());
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("archives a link after asking, and moves it to the archived list", async () => {
    const current = link();
    const sent = stub([current], {
      [`POST ${base}/important-links/${current.id}/archive`]: () =>
        Response.json({ link: { ...current, status: "archived" } }),
    });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText(/Guests stop seeing it right away/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive link" }));
    await waitFor(() => expect(screen.getByText(/Archived Fishing license/)).toBeTruthy());
    expect(sent.find((s) => s.path.endsWith("/archive"))?.key).toBeTruthy();
    expect(screen.getByText("No links for guests yet")).toBeTruthy();
    expect(screen.getByText(/Archived links \(1\)/)).toBeTruthy();
  });

  it("shows a failed read with a way to try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    renderPage();
    await loaded();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("formProblems", () => {
  const ok = {
    label: "Map",
    url: "https://example.org/",
    description: "",
    everyTrip: true,
    productIds: [],
    position: "0",
  };
  it("accepts a plain link", () => {
    expect(formProblems(ok)).toEqual({});
  });
  it("names each problem", () => {
    expect(
      formProblems({
        label: "x".repeat(61),
        url: "http://example.org/",
        description: "y".repeat(201),
        everyTrip: false,
        productIds: [],
        position: "1000",
      }),
    ).toEqual({
      label: "Use at most 60 characters.",
      url: "Use an address that starts with https://.",
      description: "Use at most 200 characters.",
      products: "Choose at least one trip.",
      position: "Use a whole number from 0 to 999.",
    });
  });
});

describe("shownOn", () => {
  it("names the trips, and a trip it no longer knows", () => {
    expect(shownOn({ productIds: [reef, "gone"] }, [{ id: reef, name: "Reef snorkel" }])).toBe(
      "Reef snorkel, A trip",
    );
  });
});
