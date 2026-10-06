export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503;

/**
 * A failure the client can act on. Handlers throw it; the app's error handler
 * renders the shared error shape. Throwing (not returning) also rolls back any
 * open tenant transaction.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const tenantNotFound = () =>
  new ApiError(404, "tenant_not_found", "No such tenant for this account");
