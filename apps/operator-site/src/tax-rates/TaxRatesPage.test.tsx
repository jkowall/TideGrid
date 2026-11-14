// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRole, TaxRate } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { membership } from "../bookings/fixtures.ts";
import { routeOf } from "../ConsoleShell.tsx";
import { NavigationProvider } from "../navigation.tsx";
import { canManageTaxRates } from "../roles.ts";
import { appliesAt, chargedAs, formProblems, percentOf, ppmOf } from "./model.ts";
import { TaxRatesPage } from "./TaxRatesPage.tsx";

const tenantId = membership("owner").tenantId;
const base = `/api/v1/staff/tenants/${tenantId}`;
const harbor = "6a1c3e5b-0d8f-4c42-9b7a-1f2e3d4c5b6a";
const marina = "7b2d4f6c-1e9a-4d53-8c8b-2a3f4e5d6c7b";

const rate = (over: Partial<TaxRate> = {}): TaxRate => ({
  id: "9c3e5a7d-2f0b-4e64-9d9c-3b4a5f6e7d8c",
  version: 1,
  name: "State sales tax",
  ratePpm: 62_500,
  inclusive: false,
  active: true,
  locationId: null,
  locationName: null,
  reason: "Set up",
  changedAt: "2026-11-11T12:00:00.000Z",
  ...over,
});

interface Sent {
  path: string;
  method: string;
  key: string | null;
  body: unknown;
}

function stub(
  initial: TaxRate[],
  answers: Record<string, () => Response> = {},
  catalog: () => Response = () =>
    Response.json({
      locations: [
        { id: harbor, name: "North Harbor", status: "active" },
        { id: marina, name: "Old Marina", status: "archived" },
      ],
      boats: [],
      products: [],
      schedules: [],
    }),
) {
  const sent: Sent[] = [];
  const rates = [...initial];
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
      if (answer) {
        const res = answer();
        const saved = res.ok
          ? ((await res
              .clone()
              .json()
              .catch(() => null)) as { taxRate?: TaxRate } | null)
          : null;
        if (saved?.taxRate) {
          const at = rates.findIndex((r) => r.id === saved.taxRate?.id);
          if (at === -1) rates.push(saved.taxRate);
          else rates[at] = saved.taxRate;
        }
        return res;
      }
      if (input === `${base}/tax-rates`) return Response.json({ taxRates: rates });
      if (input === `${base}/catalog`) return catalog();
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    }),
  );
  return sent;
}

function renderPage(role: StaffRole = "owner") {
  render(
    <NavigationProvider navigate={vi.fn()}>
      <TaxRatesPage membership={membership(role)} focusHeading={false} />
    </NavigationProvider>,
  );
}

const loaded = () => waitFor(() => expect(document.querySelector(".links-skeleton")).toBeNull());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Tax rates in the console (W3-G2.5-TAX)", () => {
  it("is the console page at /tax-rates", () => {
    expect(routeOf("/tax-rates")).toEqual({ kind: "tax_rates" });
  });

  it("lists rates in use with how each is charged and where, and retired ones apart", async () => {
    stub([
      rate(),
      rate({
        id: "a",
        name: "Harbor fee",
        ratePpm: 10_000,
        inclusive: true,
        locationId: harbor,
        locationName: "North Harbor",
        version: 3,
        reason: "County rate from January 1",
      }),
      rate({ id: "b", name: "Old levy", active: false }),
    ]);
    renderPage();
    await loaded();
    const list = screen.getByRole("list", { name: "Tax rates in use" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("6.25%, added to prices");
    expect(items[0]?.textContent).toContain("Applies at: Every location");
    expect(items[1]?.textContent).toContain("1%, included in prices");
    expect(items[1]?.textContent).toContain("Applies at: North Harbor");
    expect(items[1]?.textContent).toContain("Version 3");
    expect(items[1]?.textContent).toContain("County rate from January 1");
    expect(screen.getByText(/Retired rates \(1\)/)).toBeTruthy();
  });

  it("lets only owners add or change rates", async () => {
    expect(canManageTaxRates("owner")).toBe(true);
    for (const role of ["booking_staff", "dock_crew", "support"] as StaffRole[]) {
      expect(canManageTaxRates(role)).toBe(false);
    }
    stub([rate()]);
    renderPage("booking_staff");
    await loaded();
    expect(screen.queryByRole("button", { name: "Add a tax rate" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change/ })).toBeNull();
    expect(screen.getByText(/Only owners change tax rates/)).toBeTruthy();
  });

  it("adds a rate for one location with one key, and shows it", async () => {
    const added = rate({
      id: "new",
      name: "Harbor fee",
      ratePpm: 12_500,
      locationId: harbor,
      locationName: "North Harbor",
      reason: "New county fee",
    });
    const sent = stub([], {
      [`POST ${base}/tax-rates`]: () => Response.json({ taxRate: added }, { status: 201 }),
    });
    renderPage();
    await loaded();
    expect(screen.getByText("No tax rates in use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a tax rate" }));
    const dialog = await screen.findByRole("dialog");
    // An archived location is not offered for a new rate.
    expect(within(dialog).queryByRole("option", { name: /Old Marina/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " Harbor fee " } });
    fireEvent.change(within(dialog).getByLabelText("Rate (%)"), { target: { value: "1.25" } });
    fireEvent.change(within(dialog).getByLabelText("Applies at"), { target: { value: harbor } });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "New county fee" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = sent.filter((s) => s.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toEqual({
      name: "Harbor fee",
      ratePpm: 12_500,
      inclusive: false,
      locationId: harbor,
      reason: "New county fee",
    });
    expect(post[0]?.key).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Tax rates in use" }).textContent).toContain(
        "Harbor fee",
      ),
    );
    expect(screen.getByRole("status").textContent).toBe("Added Harbor fee.");
  });

  it("checks the form before sending and names each problem", async () => {
    const sent = stub([]);
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add a tax rate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Rate (%)"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add rate" }));
    expect(await within(dialog).findByText("Give the rate a name.")).toBeTruthy();
    expect(within(dialog).getByText(/Enter a percentage from 0.0001 to 50/)).toBeTruthy();
    expect(within(dialog).getByText("Say why, for the record.")).toBeTruthy();
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("retires a rate as its next version, keeping its archived location", async () => {
    const old = rate({ locationId: marina, locationName: "Old Marina" });
    const retired = { ...old, version: 2, active: false, reason: "Repealed" };
    const sent = stub([old], {
      [`POST ${base}/tax-rates/${old.id}/versions`]: () =>
        Response.json({ taxRate: retired }, { status: 201 }),
    });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Change State sales tax/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Saving makes version 2/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Applies at") as HTMLSelectElement).value).toBe(marina);
    fireEvent.click(within(dialog).getByLabelText("Retire this rate"));
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Repealed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = sent.find((s) => s.method === "POST");
    expect(post?.body).toEqual({
      name: "State sales tax",
      ratePpm: 62_500,
      inclusive: false,
      locationId: marina,
      reason: "Repealed",
      active: false,
    });
    await waitFor(() => expect(screen.getByText("No tax rates in use")).toBeTruthy());
    expect(screen.getByText(/Retired rates \(1\)/)).toBeTruthy();
  });

  it("sends the same key again after no answer, so the change is taken once", async () => {
    let calls = 0;
    const added = rate({ id: "new", name: "City tax" });
    const sent = stub([], {
      [`POST ${base}/tax-rates`]: () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 })
          : Response.json({ taxRate: added }, { status: 201 });
      },
    });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add a tax rate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "City tax" } });
    fireEvent.change(within(dialog).getByLabelText("Rate (%)"), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "New" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add rate" }));
    expect(await within(dialog).findByText("The rate wasn't saved")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const keys = sent.filter((s) => s.method === "POST").map((s) => s.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("still shows the rates when the locations fail to load, but offers no change", async () => {
    stub([rate()], {}, () => new Response("no", { status: 503 }));
    renderPage();
    await loaded();
    expect(screen.getByText("State sales tax")).toBeTruthy();
    expect(screen.getByText("The locations didn't load")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add a tax rate" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /Change State sales tax/ })).toBeNull();
  });

  it("shows a failed read with a way to try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    renderPage();
    expect(await screen.findByRole("button", { name: /Try again/ })).toBeTruthy();
  });
});

describe("tax rate model", () => {
  it("turns percentages into parts per million and back", () => {
    expect(ppmOf("6.25")).toBe(62_500);
    expect(ppmOf("6.25%")).toBe(62_500);
    expect(ppmOf("0.0001")).toBe(1);
    expect(ppmOf("50")).toBe(500_000);
    expect(ppmOf("50.0001")).toBeNull();
    expect(ppmOf("0")).toBeNull();
    expect(ppmOf("1.23456")).toBeNull();
    expect(ppmOf("abc")).toBeNull();
    expect(percentOf(62_500)).toBe("6.25");
    expect(percentOf(100_000)).toBe("10");
    expect(percentOf(1)).toBe("0.0001");
  });

  it("names each problem, and accepts a plain rate", () => {
    expect(formProblems({ name: "Sales tax", rate: "6", reason: "Set up" })).toEqual({});
    expect(formProblems({ name: "a\u0007b", rate: "6", reason: "x".repeat(501) })).toEqual({
      name: "Remove hidden or control characters from the name.",
      reason: "Use at most 500 characters.",
    });
  });

  it("says how and where a rate applies", () => {
    expect(chargedAs({ ratePpm: 80_000, inclusive: true })).toBe("8%, included in prices");
    expect(appliesAt({ locationId: null, locationName: null })).toBe("Every location");
    expect(appliesAt({ locationId: harbor, locationName: null })).toBe(
      "A location no longer listed",
    );
  });
});
