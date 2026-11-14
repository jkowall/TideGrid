import { z } from "zod";

/**
 * Per-location tax rates (W3-G2.5-TAX, staff screens): owners add and change
 * the operator's tax rates; every role reads them. A rate applies at every
 * location, or only to trips departing one location. Nothing is edited in
 * place: each change is a new version with a reason, and quotes keep the
 * version they used. TideGrid applies what the operator enters; it gives no
 * tax advice.
 */

/** 50%, in parts per million: the largest rate the database takes. */
export const MAX_TAX_RATE_PPM = 500_000;

const Name = z
  .string()
  .min(1)
  .max(80)
  .refine((v) => v.trim().length > 0, "A name with a visible character")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to refuse them.
  .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), "No control characters")
  .refine((v) => !/\p{Cf}/u.test(v), "No invisible format characters")
  .describe("What staff and receipts call it, such as 'State sales tax'");

const Reason = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => v.trim().length > 0, "A reason with a visible character")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to refuse them.
  .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), "No control characters")
  .describe("Why, kept with the version and in the audit log");

const TaxRateFields = {
  name: Name,
  ratePpm: z
    .number()
    .int()
    .min(1)
    .max(MAX_TAX_RATE_PPM)
    .describe("The rate in parts per million: 62,500 is 6.25%"),
  inclusive: z
    .boolean()
    .describe("True when prices already include this tax; false when it is added on top"),
  locationId: z
    .uuid()
    .nullable()
    .describe("The one location whose departures it applies to; null for every location"),
  reason: Reason,
};

export const TaxRateInput = z.strictObject(TaxRateFields).describe("A new tax rate");
export type TaxRateInput = z.infer<typeof TaxRateInput>;

export const TaxRateChange = z
  .strictObject({
    ...TaxRateFields,
    active: z.boolean().describe("False retires the rate: new quotes stop using it"),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .describe(
        "The version this change was made from; if another change came first, it answers 409 tax_rate_changed and saves nothing",
      ),
  })
  .describe("The whole rate as it should be from now on");
export type TaxRateChange = z.infer<typeof TaxRateChange>;

export const TaxRate = z.object({
  id: z.uuid(),
  version: z.number().int(),
  name: z.string(),
  ratePpm: z.number().int(),
  inclusive: z.boolean(),
  active: z.boolean(),
  locationId: z.uuid().nullable(),
  locationName: z.string().nullable().describe("The location's name; null for every location"),
  reason: z.string().describe("The reason given for the current version"),
  changedAt: z.iso.datetime({ offset: true }),
});
export type TaxRate = z.infer<typeof TaxRate>;

export const TaxRateResponse = z.object({ taxRate: TaxRate });
export type TaxRateResponse = z.infer<typeof TaxRateResponse>;

export const TaxRatesResponse = z.object({
  taxRates: z.array(TaxRate).describe("Active rates by name, then retired ones"),
});
export type TaxRatesResponse = z.infer<typeof TaxRatesResponse>;
