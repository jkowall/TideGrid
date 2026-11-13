import { z } from "zod";

/**
 * The standard CSV import's dry run (W3-G2.13, part 1): an owner sends a
 * batch of legacy CSV files and gets back every refused row and every control
 * total, with nothing from the files written. The files, columns, codes, and
 * totals follow the draft in docs/v2/drafts/standard-csv-import.md, a
 * coordinator default pending the owner's approval.
 */

/** The most characters one file may hold; the whole request is capped at 4 MiB. */
export const MAX_IMPORT_FILE_CHARS = 2_000_000;
/** The most issues the JSON answer lists; errors.csv has up to 5,000. */
export const MAX_IMPORT_ISSUES_LISTED = 500;

const FileText = z
  .string()
  .min(1)
  .max(MAX_IMPORT_FILE_CHARS)
  .describe("The file's text, UTF-8, as exported (RFC 4180 CSV)");

export const ImportFileName = z.enum([
  "manifest.csv",
  "products.csv",
  "trips.csv",
  "customers.csv",
  "bookings.csv",
  "participants.csv",
  "payments.csv",
  "opening_balances.csv",
  "waivers.csv",
]);
export type ImportFileName = z.infer<typeof ImportFileName>;

export const ImportDryRunRequest = z
  .object({
    files: z
      .object({
        "manifest.csv": FileText,
        "products.csv": FileText.optional(),
        "trips.csv": FileText.optional(),
        "customers.csv": FileText.optional(),
        "bookings.csv": FileText.optional(),
        "participants.csv": FileText.optional(),
        "payments.csv": FileText.optional(),
        "opening_balances.csv": FileText.optional(),
        "waivers.csv": FileText.optional(),
      })
      .strict()
      .describe("One batch: the manifest and the files it declares totals for"),
  })
  .strict();
export type ImportDryRunRequest = z.infer<typeof ImportDryRunRequest>;

export const ImportIssue = z.object({
  file: ImportFileName,
  line: z
    .number()
    .int()
    .nullable()
    .describe("The record number, the header being 1; null for the whole file"),
  recordKey: z.string().nullable().describe("The row's deduplication key"),
  column: z.string().nullable(),
  code: z.string().describe("A stable code, as the draft lists them"),
  severity: z.enum(["error", "warning"]).describe("error refuses the row; warning needs review"),
  message: z.string(),
  value: z
    .string()
    .nullable()
    .describe('The offending value, or "[withheld]" for a name, email, phone, or reference'),
});
export type ImportIssue = z.infer<typeof ImportIssue>;

export const ImportDryRunResponse = z.object({
  run: z.object({
    id: z.uuid().nullable().describe("The recorded run; null when the manifest could not be read"),
    batchId: z.string().nullable(),
    runNumber: z.number().int().nullable(),
    sourceSystem: z.string().nullable(),
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("SHA-256 of the files, without the manifest's batch_mode and run_number rows"),
    checkedAt: z.iso.datetime({ offset: true }),
    clean: z.boolean().describe("No error and every declared total matched"),
    errorCount: z.number().int(),
    warningCount: z.number().int(),
    files: z.array(
      z.object({
        file: ImportFileName,
        rows: z.number().int(),
        accepted: z.number().int(),
        refused: z.number().int(),
      }),
    ),
    controls: z.array(
      z.object({
        file: ImportFileName,
        metric: z.string(),
        declared: z.number().int().nullable(),
        computed: z.number().int(),
        matches: z.boolean(),
      }),
    ),
    issues: z.array(ImportIssue).max(MAX_IMPORT_ISSUES_LISTED),
    issuesTruncated: z
      .boolean()
      .describe(
        "More issues than listed; errors.csv has the first 5,000, and the counts cover them all",
      ),
  }),
  errorsCsv: z
    .string()
    .describe("errors.csv: the first 5,000 issues, each cell kept from running as a formula"),
});
export type ImportDryRunResponse = z.infer<typeof ImportDryRunResponse>;

// The commit (W3-G2.13, commit step, part A) -----------------------------------------

export const ImportCommitRequest = ImportDryRunRequest;
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

export const ImportCommitCounts = z
  .object({
    trips: z.number().int().describe("Trips recorded, existing departures included"),
    tripsCreated: z.number().int().describe("New departures, created in draft"),
    customers: z.number().int(),
    bookings: z.number().int(),
    participants: z.number().int(),
    payments: z.number().int(),
    refunds: z.number().int(),
    unchanged: z
      .number()
      .int()
      .describe("Rows imported before with the same values: nothing written for them"),
  })
  .describe("What the commit wrote");
export type ImportCommitCounts = z.infer<typeof ImportCommitCounts>;

export const ImportCommitResponse = ImportDryRunResponse.extend({
  committed: z.boolean().describe("True when the batch was saved, all of it"),
  refusal: z
    .enum(["not_clean", "write_refused"])
    .nullable()
    .describe(
      "Why nothing was saved: the files no longer pass their checks (not_clean, with the issues listed), or TideGrid changed while saving (write_refused). A refused commit is recorded, so the next try needs a fresh dry run",
    ),
  refusedBy: z
    .string()
    .max(63)
    .nullable()
    .describe(
      "For write_refused: the name of the TideGrid rule that refused the save, when known, for support to look up. Null otherwise",
    ),
  counts: ImportCommitCounts.nullable(),
});
export type ImportCommitResponse = z.infer<typeof ImportCommitResponse>;
