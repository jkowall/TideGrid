import type { StaffRole } from "@tidegrid/contracts";
import type { ColumnType, Generated, GeneratedAlways } from "kysely";

/**
 * Database types grow with each reviewed migration. Keep this file in step with
 * `migrations/`; a mismatch is a review finding. Only tables the runtime role
 * may touch appear here. Credential tables are reachable through the functions
 * in schema `app` only and are deliberately absent.
 */

export type JsonObject = { [key: string]: unknown };
/** bigint columns arrive from postgres.js as strings. */
type BigIntId = ColumnType<string, never, never>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, never, never>;
type Json = ColumnType<JsonObject, JsonObject, JsonObject>;
type NullableJson = ColumnType<JsonObject | null, JsonObject | null | undefined, JsonObject | null>;
/** Defaulted from app.current_tenant_id(); pass it explicitly anyway. */
type TenantColumn = ColumnType<string, string | undefined, never>;

export interface SchemaMigrationsTable {
  name: string;
  checksum: string;
  applied_at: ColumnType<Date, string | undefined, never>;
}

export type TenantStatus = "active" | "suspended";

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  display_name: string;
  status: Generated<TenantStatus>;
  created_at: CreatedAt;
}

export type HostnameKind = "preview" | "custom";
export type HostnameStatus = "pending" | "active" | "disabled";

export interface TenantHostnamesTable {
  hostname: string;
  tenant_id: string;
  kind: HostnameKind;
  status: Generated<HostnameStatus>;
  verified_at: Date | null;
  created_at: CreatedAt;
}

export type StaffUserStatus = "active" | "disabled";

/** The runtime may read these columns only; the identity's own name is withheld from tenants. */
export interface StaffUsersTable {
  id: Generated<string>;
  email: string;
  status: Generated<StaffUserStatus>;
  created_at: CreatedAt;
}

export type MembershipStatus = "active" | "disabled";

export interface TenantMembershipsTable {
  tenant_id: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  role: StaffRole;
  status: Generated<MembershipStatus>;
  /** How this tenant names the person; other tenants never see it. */
  display_name: string;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type ActorType = "staff" | "guest" | "system" | "support";

export interface AuditEventsTable {
  tenant_id: TenantColumn;
  id: BigIntId;
  occurred_at: CreatedAt;
  actor_type: ColumnType<ActorType, ActorType | undefined, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  source_ip: ColumnType<string | null, string | null | undefined, never>;
  action: ColumnType<string, string, never>;
  subject_type: ColumnType<string, string, never>;
  subject_id: ColumnType<string, string, never>;
  reason: ColumnType<string | null, string | null | undefined, never>;
  before_state: NullableJson;
  after_state: NullableJson;
}

export type IdempotencyStatus = "in_progress" | "completed";

export interface IdempotencyKeysTable {
  tenant_id: TenantColumn;
  scope: ColumnType<string, string, never>;
  principal: ColumnType<string, string, never>;
  key: ColumnType<string, string, never>;
  request_hash: ColumnType<string, string, never>;
  status: Generated<IdempotencyStatus>;
  response_status: number | null;
  response_body: NullableJson;
  created_at: CreatedAt;
  completed_at: Timestamp | null;
  expires_at: ColumnType<Date, never, never>;
}

export interface OutboxEventsTable {
  tenant_id: TenantColumn;
  id: BigIntId;
  topic: ColumnType<string, string, never>;
  aggregate_type: ColumnType<string, string, never>;
  aggregate_id: ColumnType<string, string, never>;
  payload: Json;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
  available_at: ColumnType<Date, Date | string | undefined, never>;
  published_at: ColumnType<Date | null, never, never>;
  attempts: ColumnType<number, never, never>;
  last_error: ColumnType<string | null, never, never>;
}

// Catalog and schedule (migration 0003). Columns typed `never` for update are
// not granted to the runtime.

/** A column written once and never updated by the runtime. */
type Fixed<T> = ColumnType<T, T, never>;
type FixedDefault<T> = ColumnType<T, T | undefined, never>;
/**
 * A date column. postgres.js parses dates into Dates at UTC midnight; write them
 * as "YYYY-MM-DD" and read them back through that UTC calendar date.
 */
type DateColumn = ColumnType<Date, string, never>;
type Instant = ColumnType<Date, Date | string, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

export type ProductKind = "shared_seat" | "private_charter";
export type ProductSalesStatus = "draft" | "published" | "archived";
export type TripSalesState = "draft" | "published" | "closed" | "canceled" | "completed";
export type AmbiguousTimeChoice = "earlier" | "later" | "reject";

export interface LocationsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  name: Fixed<string>;
  time_zone: Fixed<string>;
  meeting_point: FixedDefault<string>;
  meeting_instructions: FixedDefault<string>;
  status: FixedDefault<"active" | "archived">;
  created_at: CreatedAt;
  updated_at: FixedDefault<Date>;
}

export interface BoatsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  name: Fixed<string>;
  guest_capacity: Fixed<number>;
  status: FixedDefault<"active" | "retired">;
  created_at: CreatedAt;
  updated_at: FixedDefault<Date>;
}

export interface ProductsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  location_id: Fixed<string>;
  kind: Fixed<ProductKind>;
  name: Fixed<string>;
  summary: FixedDefault<string>;
  duration_minutes: Fixed<number>;
  booking_cutoff_minutes: FixedDefault<number>;
  turnaround_buffer_minutes: FixedDefault<number>;
  min_party_size: FixedDefault<number>;
  max_party_size: Fixed<number>;
  seat_limit: FixedDefault<number | null>;
  sales_status: ColumnType<ProductSalesStatus, ProductSalesStatus | undefined, ProductSalesStatus>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ProductBoatsTable {
  tenant_id: TenantColumn;
  product_id: Fixed<string>;
  boat_id: Fixed<string>;
  created_at: CreatedAt;
}

export interface SchedulesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  product_id: Fixed<string>;
  boat_id: Fixed<string>;
  time_zone: Fixed<string>;
  starts_on: DateColumn;
  ends_on: DateColumn;
  weekdays: Fixed<number[]>;
  /** "HH:MM:SS" strings. */
  start_times: Fixed<string[]>;
  ambiguous_time: FixedDefault<AmbiguousTimeChoice>;
  status: FixedDefault<"active" | "paused" | "ended">;
  created_at: CreatedAt;
  updated_at: FixedDefault<Date>;
}

export interface ScheduledTripsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  product_id: Fixed<string>;
  boat_id: Fixed<string>;
  schedule_id: FixedDefault<string | null>;
  time_zone: Fixed<string>;
  local_date: DateColumn;
  /** "HH:MM:SS". */
  local_start_time: Fixed<string>;
  starts_at: Instant;
  ends_at: Instant;
  /** The end plus the product's turnaround buffer; set by the database. */
  boat_free_at: ColumnType<Date, never, never>;
  start_utc_offset_minutes: Fixed<number>;
  end_utc_offset_minutes: Fixed<number>;
  duration_minutes: Fixed<number>;
  seat_capacity: Fixed<number>;
  sales_state: ColumnType<TripSalesState, TripSalesState | undefined, TripSalesState>;
  sales_state_changed_at: UpdatedAt;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BlackoutsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  location_id: FixedDefault<string | null>;
  product_id: FixedDefault<string | null>;
  boat_id: FixedDefault<string | null>;
  time_zone: Fixed<string>;
  starts_on: DateColumn;
  ends_on: DateColumn;
  starts_at: Instant;
  ends_at: Instant;
  reason: Fixed<string>;
  created_at: CreatedAt;
}

export interface Database {
  schema_migrations: SchemaMigrationsTable;
  tenants: TenantsTable;
  tenant_hostnames: TenantHostnamesTable;
  staff_users: StaffUsersTable;
  tenant_memberships: TenantMembershipsTable;
  audit_events: AuditEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  outbox_events: OutboxEventsTable;
  locations: LocationsTable;
  boats: BoatsTable;
  products: ProductsTable;
  product_boats: ProductBoatsTable;
  schedules: SchedulesTable;
  scheduled_trips: ScheduledTripsTable;
  blackouts: BlackoutsTable;
}

export type { Generated, GeneratedAlways };
