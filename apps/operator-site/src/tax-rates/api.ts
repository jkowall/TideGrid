import type {
  CatalogResponse,
  TaxRate,
  TaxRateChange,
  TaxRateInput,
  TaxRateResponse,
  TaxRatesResponse,
} from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * Tax rates (W3-G2.5-TAX staff screens): the console's calls. Every role
 * reads the operator's rates; owners add and change them. The API decides who
 * may; the console's role check only decides what to show. No call throws.
 */

export type Read<T> = { kind: "ok"; value: T } | { kind: "failed"; reason: ReadFailure };

/** A location a rate can be limited to. */
export interface RateLocation {
  id: string;
  name: string;
  archived: boolean;
}

export interface TaxRatesPage {
  rates: TaxRate[];
  locations: RateLocation[];
  /** False when the locations did not load: rates still show, but none can be added or changed. */
  locationsLoaded: boolean;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Whether an answer has what the page shows, in a form it can show. */
export function isRate(value: unknown): value is TaxRate {
  const r = value as Partial<TaxRate> | null;
  return (
    isString(r?.id) &&
    Number.isInteger(r.version) &&
    isString(r.name) &&
    Number.isInteger(r.ratePpm) &&
    typeof r.inclusive === "boolean" &&
    typeof r.active === "boolean" &&
    (r.locationId === null || isString(r.locationId)) &&
    (r.locationName === null || isString(r.locationName)) &&
    isString(r.reason) &&
    isString(r.changedAt)
  );
}

const ratesPath = (tenantId: string) => `${tenantPath(tenantId)}/tax-rates`;

/** The operator's rates and its locations. */
export async function loadTaxRates(
  tenantId: string,
  signal?: AbortSignal,
): Promise<Read<TaxRatesPage>> {
  try {
    // The catalog is caught on its own, so a failure there never hides the rates.
    const [ratesRes, catalogRes] = await Promise.all([
      call(ratesPath(tenantId), { headers: { accept: "application/json" } }, signal),
      call(`${tenantPath(tenantId)}/catalog`, { headers: { accept: "application/json" } }, signal)
        .then((res) => res)
        .catch(() => null),
    ]);
    if (!ratesRes.ok) return { kind: "failed", reason: await failureOf(ratesRes) };
    const body = (await ratesRes.json().catch(() => null)) as Partial<TaxRatesResponse> | null;
    if (!Array.isArray(body?.taxRates) || !body.taxRates.every(isRate)) {
      return { kind: "failed", reason: "unreadable" };
    }
    let locations: RateLocation[] = [];
    let locationsLoaded = false;
    if (catalogRes?.ok) {
      const catalog = (await catalogRes
        .json()
        .catch(() => null)) as Partial<CatalogResponse> | null;
      if (Array.isArray(catalog?.locations)) {
        locationsLoaded = true;
        locations = catalog.locations
          .filter((l) => isString(l?.id) && isString(l.name))
          .map((l) => ({ id: l.id, name: l.name, archived: l.status === "archived" }));
      }
    }
    return { kind: "ok", value: { rates: body.taxRates, locations, locationsLoaded } };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

/** Why a change was not saved. */
export type SaveFailure = ReadFailure | "unknown_location" | "key_reused";

export type SaveResult = { kind: "saved"; rate: TaxRate } | { kind: "failed"; reason: SaveFailure };

async function save(path: string, body: TaxRateInput | TaxRateChange, key: string) {
  try {
    const res = await call(path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const answer = (await res.json().catch(() => null)) as Partial<TaxRateResponse> | null;
      return isRate(answer?.taxRate)
        ? ({ kind: "saved", rate: answer.taxRate } as const)
        : ({ kind: "failed", reason: "unreadable" } as const);
    }
    if (res.status === 422) {
      const code = await errorCode(res.clone());
      if (code === "tax_rate_unknown_location") {
        return { kind: "failed", reason: "unknown_location" } as const;
      }
      if (code === "idempotency_key_reused")
        return { kind: "failed", reason: "key_reused" } as const;
    }
    return { kind: "failed", reason: await failureOf(res) } as const;
  } catch {
    return { kind: "failed", reason: "unreachable" } as const;
  }
}

/** Add a rate. `key`: one per set of details, kept when the same ones are sent again. */
export function addTaxRate(
  tenantId: string,
  input: TaxRateInput,
  key: string,
): Promise<SaveResult> {
  return save(ratesPath(tenantId), input, key);
}

/** Restate a rate as its next version; `active: false` retires it. */
export function changeTaxRate(
  tenantId: string,
  taxRateId: string,
  input: TaxRateChange,
  key: string,
): Promise<SaveResult> {
  return save(`${ratesPath(tenantId)}/${encodeURIComponent(taxRateId)}/versions`, input, key);
}
