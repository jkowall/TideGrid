import { ErrorResponse } from "@tidegrid/contracts";

/** Shared OpenAPI declaration for error bodies. */
export const errorBody = (description: string) => ({
  content: { "application/json": { schema: ErrorResponse } },
  description,
});

export const staffSecurity = [{ accessJwt: [] }, { sessionCookie: [] }];
