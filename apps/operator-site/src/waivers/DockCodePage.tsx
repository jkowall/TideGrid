import type { Membership } from "@tidegrid/contracts";
import { Button, Notice, Skeleton } from "@tidegrid/design-system/components";
import { useEffect, useState } from "react";
import { ReadFailed } from "../bookings/States.tsx";
import type { ReadFailure } from "../http.ts";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { type DockCodeRead, loadDockCode } from "./api.ts";
import { encodeQr, qrPath } from "./qr.ts";
import "./dock.css";

/**
 * The printable dock QR code (W3-G2.15-rest, owner decision 2026-11-13). One
 * code, posted at the dock, opens the operator's guest site's dock page,
 * where a guest types the booking code and the booker's last name and signs
 * on their own phone on the day of the trip. The code carries no token, name,
 * or booking detail, so one print serves every trip. Owners and booking staff.
 */

export const dockCodePath = "/dock-code";

type Load =
  | { kind: "loading" }
  | Exclude<DockCodeRead, { kind: "failed" }>
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

/** The QR code as one SVG path; null when the address is too long for it. */
export function DockQr({ url }: { url: string }) {
  let code: ReturnType<typeof encodeQr>;
  try {
    code = encodeQr(url);
  } catch {
    return null;
  }
  const size = code.size + 8;
  return (
    <svg
      className="dock-sheet__qr"
      role="img"
      aria-label="QR code that opens the dock page for signing waivers"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(code)} fill="#000" />
    </svg>
  );
}

export function DockCodePage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName } = membership;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    void loadDockCode(tenantId, abort.signal).then((read) => {
      if (abort.signal.aborted) return;
      setLoad((was) =>
        read.kind === "failed"
          ? {
              kind: "failed",
              reason: read.reason,
              failures: was.kind === "failed" ? was.failures + 1 : 1,
              retrying: false,
            }
          : read,
      );
    });
    return () => abort.abort();
  }, [tenantId, attempt]);

  return (
    <>
      <PageHeader eyebrow="Waivers" title="Dock QR code" focusHeading={focusHeading} />
      <p className="dock-lede">
        Print this and post it where guests board. A guest scans it, types the booking code and the
        last name of the person who booked, and signs on their own phone. It works only on the day
        of the trip, and shows only that booking's party. The code holds no booking details, so one
        print works for every trip. Guests who can't use it can sign with you from the booking's
        Waivers panel.
      </p>
      {load.kind === "loading" && (
        <div className="dock-sheet" aria-busy="true">
          <p className="tg-visually-hidden" role="status">
            Loading the dock QR code…
          </p>
          <Skeleton width="12rem" height="12rem" />
        </div>
      )}
      {load.kind === "failed" && (
        <ReadFailed
          reason={load.reason}
          noun="the dock QR code"
          tenantName={tenantName}
          failures={load.failures}
          retrying={load.retrying}
          onRetry={() => {
            setLoad({ ...load, retrying: true });
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {load.kind === "no_site" && (
        <Notice tone="warning" title="Your booking site has no address yet">
          The dock page lives on your guest booking site. Once the site has its address, the code
          appears here.
        </Notice>
      )}
      {load.kind === "ok" && <DockSheet url={load.url} tenantName={tenantName} />}
    </>
  );
}

function DockSheet({ url, tenantName }: { url: string; tenantName: string }) {
  const qr = <DockQr url={url} />;
  const shown = url.replace(/^https?:\/\//, "");
  return (
    <>
      <div className="dock-actions">
        <Button variant="primary" icon="printer" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <section className="dock-sheet" aria-label="The sign to print">
        <p className="dock-sheet__operator">{tenantName}</p>
        <h2 className="dock-sheet__title">Sign your waiver here</h2>
        {qr ?? (
          <Notice tone="error" title="The QR code didn't fit">
            Your booking site's address is too long for a QR code. Guests can type the address below
            instead.
          </Notice>
        )}
        <ol className="dock-sheet__steps">
          <li>Scan the code with your phone's camera.</li>
          <li>Enter your booking code and the last name of the person who booked.</li>
          <li>Sign for each person in your party who still needs to.</li>
        </ol>
        <p className="dock-sheet__address">
          Or go to <strong>{shown}</strong>
        </p>
        <p className="dock-sheet__fine">Works on the day of your trip. Questions? Ask the crew.</p>
      </section>
    </>
  );
}
