import {
  type Problem,
  ProblemResponse,
  type ProblemStatus,
  problemBody,
} from "@tidegrid/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";

/**
 * Problem details for the guest commands (W1-GUEST-API, D1). Their 409 and
 * 422 answers keep the shared error envelope and add the RFC 9457 members,
 * every problem by code and subject, and, for too few seats, the count left
 * on the trip asked about. The app's error handler renders only the envelope,
 * so these routes catch their own refusals and render the problem body here.
 */

/** A refusal with its problems, and for too few seats, the count left. */
export class ProblemError extends ApiError {
  constructor(
    status: ProblemStatus,
    code: string,
    message: string,
    readonly problems: readonly Problem[],
    readonly remaining?: number,
  ) {
    super(status, code, message);
    this.name = "ProblemError";
  }
}

/** OpenAPI declaration for a problem answer. */
export const problemAnswer = (description: string) => ({
  content: { "application/json": { schema: ProblemResponse } },
  description,
});

/**
 * The problem body for a 409 or 422 thrown by a guest command, or null for
 * anything else, which the app's error handler renders as before.
 */
export function problemFor(c: Context<AppEnv>, err: unknown): ProblemResponse | null {
  if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 422)) return null;
  const requestId = c.get("requestId") ?? "unknown";
  if (err instanceof ProblemError) {
    return problemBody({
      status: err.status as ProblemStatus,
      code: err.code,
      message: err.message,
      requestId,
      problems: err.problems,
      ...(err.remaining === undefined ? {} : { remaining: err.remaining }),
    });
  }
  return problemBody({ status: err.status, code: err.code, message: err.message, requestId });
}

/** Run a guest command; render its 409 and 422 refusals as problem details. */
export async function withProblems<T>(c: Context<AppEnv>, run: () => Promise<T>) {
  try {
    return await run();
  } catch (err) {
    const problem = problemFor(c, err);
    if (!problem) throw err;
    return problem.status === 409 ? c.json(problem, 409) : c.json(problem, 422);
  }
}
