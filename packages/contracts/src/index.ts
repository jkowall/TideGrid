import { z } from "zod";

/**
 * Shared API contracts. Every request and response schema the API exposes is
 * defined here and reused by the Worker (validation and OpenAPI) and the web
 * clients (types). Money is integer cents; instants are RFC 3339 strings.
 */

export const apiVersion = "v1" as const;

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string().describe("Deployed build identifier"),
    environment: z.enum(["local", "preview", "staging", "production"]),
    database: z.enum(["ok", "error", "unconfigured"]),
    migrations: z
      .object({ applied: z.number().int().nonnegative(), latest: z.string().nullable() })
      .nullable(),
    time: z.string().datetime({ offset: true }),
  })
  .describe("Service health for synthetic checks; carries no tenant data");

export type HealthResponse = z.infer<typeof HealthResponse>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;
