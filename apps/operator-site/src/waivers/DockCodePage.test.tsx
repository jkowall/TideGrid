// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { StaffRole } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { membership } from "../bookings/fixtures.ts";
import { routeOf } from "../ConsoleShell.tsx";
import { canPrintDockCode } from "../roles.ts";
import { DockCodePage, dockCodePath } from "./DockCodePage.tsx";

const tenantId = membership("owner").tenantId;
const path = `/api/v1/staff/tenants/${tenantId}/waiver-dock-code`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(answer: () => Response): string[] {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      sent.push(input);
      return answer();
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the dock QR code page", () => {
  it("has its own address, for owners and booking staff", () => {
    expect(routeOf(dockCodePath)).toEqual({ kind: "dock_code" });
    const roles: StaffRole[] = ["owner", "booking_staff", "finance"];
    expect(roles.map(canPrintDockCode)).toEqual([true, true, false]);
  });

  it("draws one QR code for the guest site's dock page, with the address to type", async () => {
    const sent = stub(() => json(200, { url: "https://demo.book.example.test/dock" }));
    render(<DockCodePage membership={membership("owner")} focusHeading={false} />);
    const qr = await screen.findByRole("img", {
      name: "QR code that opens the dock page for signing waivers",
    });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
    expect(screen.getByText("demo.book.example.test/dock")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print" })).toBeTruthy();
    expect(sent).toEqual([path]);
  });

  it("says when the booking site has no address, and refuses an answer that is not the dock page", async () => {
    stub(() =>
      json(409, {
        error: { code: "waiver_guest_site_unavailable", message: "x", requestId: "r" },
      }),
    );
    render(<DockCodePage membership={membership("owner")} focusHeading={false} />);
    expect(await screen.findByText("Your booking site has no address yet")).toBeTruthy();
    cleanup();
    stub(() => json(200, { url: "https://elsewhere.example.test/phish" }));
    render(<DockCodePage membership={membership("owner")} focusHeading={false} />);
    expect(await screen.findByRole("button", { name: /Try again|Reload/ })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
