/**
 * Structured logging with OpenTelemetry semantic-convention attribute names.
 * Output is one JSON object per line so Workers Logs can index it. Values that
 * could carry guest data are redacted by allowlist: only the keys below pass.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RequestAttributes {
  "http.request.method"?: string;
  "url.path"?: string;
  "http.response.status_code"?: number;
  "server.address"?: string;
  "tidegrid.request_id"?: string;
  "tidegrid.tenant_id"?: string;
  "tidegrid.environment"?: string;
  "error.type"?: string;
  "event.name"?: string;
  /** Staff user id (a UUID). Never an email address. */
  "user.id"?: string;
  duration_ms?: number;
}

const allowedKeys = new Set<keyof RequestAttributes>([
  "http.request.method",
  "url.path",
  "http.response.status_code",
  "server.address",
  "tidegrid.request_id",
  "tidegrid.tenant_id",
  "tidegrid.environment",
  "error.type",
  "event.name",
  "user.id",
  "duration_ms",
]);

const tokenLike = /^[A-Za-z0-9_-]{24,}$/;
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replace path segments that look like bearer material. Routes are designed so
 * tokens travel in fragments, bodies, and cookies, never paths; this is the
 * backstop if one ever does. UUID identifiers are kept for correlation.
 */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (tokenLike.test(segment) && !uuidLike.test(segment) ? ":redacted" : segment))
    .join("/");
}

export function redact(attrs: Record<string, unknown>): RequestAttributes {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!allowedKeys.has(k as keyof RequestAttributes) || v === undefined) continue;
    out[k] = k === "url.path" && typeof v === "string" ? redactPath(v) : v;
  }
  return out as RequestAttributes;
}

export interface Logger {
  debug(message: string, attrs?: Record<string, unknown>): void;
  info(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
  child(attrs: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => console.log(line),
): Logger {
  const baseAttrs = redact(base);
  const emit = (level: LogLevel, message: string, attrs?: Record<string, unknown>) => {
    sink(
      JSON.stringify({
        level,
        message,
        time: new Date().toISOString(),
        ...baseAttrs,
        ...(attrs ? redact(attrs) : {}),
      }),
    );
  };
  return {
    debug: (m, a) => emit("debug", m, a),
    info: (m, a) => emit("info", m, a),
    warn: (m, a) => emit("warn", m, a),
    error: (m, a) => emit("error", m, a),
    child: (attrs) => createLogger({ ...baseAttrs, ...attrs }, sink),
  };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
