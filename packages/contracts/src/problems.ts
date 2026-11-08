import { z } from "zod";

/**
 * Problem details for the guest commands (W1-GUEST-API, D1). The body keeps
 * the shared error envelope (`error.code`, `error.message`, `error.requestId`)
 * that every client already reads, and adds the RFC 9457 members beside it:
 * `type`, `title`, `status`, and `detail`, plus two extension members, `code`
 * (the same stable code as `error.code`) and `problems` (every problem, by
 * code and subject). A capacity refusal also carries `remaining`: the seats
 * left on the trip the request asked about, as a count only (D2). The media
 * type stays `application/json`, so no client that reads the envelope sees a
 * change.
 */

/** One reason a command was refused, with what it is about. */
export const Problem = z
  .object({
    code: z.string().describe("A stable machine code, such as a quote problem code"),
    subject: z
      .string()
      .nullable()
      .describe("The ticket type or add-on code the problem is about, or null"),
  })
  .describe("One problem with the request");
export type Problem = z.infer<typeof Problem>;

/** RFC 9457 `title` for a status, when `type` is about:blank. */
export const problemTitles = {
  409: "Conflict",
  422: "Unprocessable Content",
} as const;
export type ProblemStatus = keyof typeof problemTitles;

export const ProblemResponse = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
      })
      .describe("The shared error envelope, unchanged"),
    type: z
      .literal("about:blank")
      .describe("RFC 9457 problem type; about:blank, so `code` names the problem"),
    title: z.string().describe("RFC 9457 title: the HTTP status phrase"),
    status: z.number().int().min(400).max(599).describe("RFC 9457 status: the HTTP status"),
    detail: z.string().describe("RFC 9457 detail: the same text as error.message"),
    code: z.string().describe("Stable machine code, equal to error.code"),
    problems: z
      .array(Problem)
      .min(1)
      .describe("Every problem found; the first one is `code`. Read these, not the message text"),
    remaining: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "With insufficient_capacity only: seats left on the trip this request asked about, as a count. Nothing about other trips, holds, or bookings",
      ),
  })
  .meta({
    id: "ProblemResponse",
    description:
      "RFC 9457 problem details beside the shared error envelope, served as application/json",
  });
export type ProblemResponse = z.infer<typeof ProblemResponse>;

/** Build a problem body. `problems` defaults to the code alone. */
export function problemBody(input: {
  status: ProblemStatus;
  code: string;
  message: string;
  requestId: string;
  problems?: readonly Problem[];
  remaining?: number;
}): ProblemResponse {
  const problems =
    input.problems && input.problems.length > 0
      ? input.problems.map((p) => ({ code: p.code, subject: p.subject }))
      : [{ code: input.code, subject: null }];
  return {
    error: { code: input.code, message: input.message, requestId: input.requestId },
    type: "about:blank",
    title: problemTitles[input.status],
    status: input.status,
    detail: input.message,
    code: input.code,
    problems,
    ...(input.remaining === undefined ? {} : { remaining: input.remaining }),
  };
}
