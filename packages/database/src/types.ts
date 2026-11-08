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

/** `platform` is admitted for an explicit allowlist only (0011, G2.14b D19). */
export type HostnameKind = "preview" | "custom" | "platform";
export type HostnameStatus = "pending" | "active" | "disabled";

/** Read-only for the runtime: no INSERT, no UPDATE. Admin functions in schema `app` write it. */
export interface TenantHostnamesTable {
  hostname: ColumnType<string, never, never>;
  tenant_id: ColumnType<string, never, never>;
  kind: ColumnType<HostnameKind, never, never>;
  status: ColumnType<HostnameStatus, never, never>;
  verified_at: ColumnType<Date | null, never, never>;
  created_at: CreatedAt;
}

export type ProvisioningHostnameState =
  | "pending"
  | "active"
  | "moved"
  | "blocked"
  | "deleted"
  | "unknown";
export type ProvisioningCertificateState = "pending" | "active" | "expiring" | "failed" | "unknown";

/**
 * A custom hostname's provider record and latest reading (0011, G2.14b).
 * Read-only for the runtime; it writes through app.hostname_record_check only.
 */
export interface TenantHostnameProvisioningTable {
  tenant_id: ColumnType<string, never, never>;
  hostname: ColumnType<string, never, never>;
  provider: ColumnType<"fake" | "cloudflare_saas", never, never>;
  provider_hostname_id: ColumnType<string | null, never, never>;
  hostname_state: ColumnType<ProvisioningHostnameState, never, never>;
  certificate_state: ColumnType<ProvisioningCertificateState, never, never>;
  instructions: ColumnType<unknown[], never, never>;
  last_error_code: ColumnType<string | null, never, never>;
  last_checked_at: ColumnType<Date | null, never, never>;
  next_check_at: ColumnType<Date, never, never>;
  check_attempts: ColumnType<number, never, never>;
  claim_expires_at: ColumnType<Date, never, never>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, never>;
}

export type StaffUserStatus = "active" | "disabled";

/** The runtime may read these columns only; the identity's own name is withheld from tenants. */
export interface StaffUsersTable {
  id: Generated<string>;
  email: string;
  status: Generated<StaffUserStatus>;
  created_at: CreatedAt;
}

/** A runtime insert is always `invited` (W3-G2.2b); only the invited person accepts. */
export type MembershipStatus = "invited" | "active" | "disabled";

export interface TenantMembershipsTable {
  tenant_id: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  role: StaffRole;
  status: Generated<MembershipStatus>;
  /** How this tenant names the person; other tenants never see it. */
  display_name: string;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** Stamped by the membership trigger from the actor and the clock (W3-G2.2b). */
  invited_by: ColumnType<string | null, never, never>;
  invited_at: ColumnType<Date | null, never, never>;
  invitation_expires_at: ColumnType<Date | null, never, never>;
  /** Set only by app.auth_respond_invitation, or by a seed. */
  accepted_at: ColumnType<Date | null, never, never>;
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
  // Delivery columns (0023, W3-G2.3): the publisher and the consumer move these.
  available_at: ColumnType<Date, Date | string | undefined, Date | string>;
  published_at: ColumnType<Date | null, never, Date | string | null>;
  delivered_at: ColumnType<Date | null, never, Date | string | null>;
  attempts: ColumnType<number, never, number>;
  last_error: ColumnType<string | null, never, string | null>;
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

/** Who may publish or activate a brand. Guests never do. */
export type BrandActorType = "staff" | "system" | "support";

/** Append-only. `config` is the brand contract's BrandConfig, validated by the writer. */
export interface BrandConfigVersionsTable {
  tenant_id: TenantColumn;
  version: ColumnType<number, number, never>;
  schema_version: ColumnType<number, number, never>;
  config: ColumnType<JsonObject, JsonObject, never>;
  created_at: CreatedAt;
  actor_type: ColumnType<BrandActorType, BrandActorType | undefined, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
}

/** Append-only. The tenant's latest activation (highest id) is its active brand. */
export interface BrandActivationsTable {
  tenant_id: TenantColumn;
  id: BigIntId;
  version: ColumnType<number, number, never>;
  activated_at: CreatedAt;
  actor_type: ColumnType<BrandActorType, BrandActorType | undefined, never>;
  actor_id: ColumnType<string | null, string | null | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  reason: ColumnType<string, string, never>;
}

// Pricing, policies, and quotes (migration 0005) ---------------------------------
// Every table is append-only for every role: the runtime may insert and read.
// Money is integer US cents; tax rates are parts per million; discounts and
// refunds are basis points. `created_txid` is stamped by the database.

/** Who may write terms. Guests never do; they may only create quotes. */
export type TermsActorType = "staff" | "system" | "support";
export type PriceItemKind = "ticket" | "charter" | "fee" | "add_on";
export type ChargeBasis = "per_booking" | "per_participant";
export type PolicyRemedy = "full_refund" | "percent_refund" | "credit" | "none";
export type DiscountKind = "fixed_amount" | "percent";
export type QuoteLineKind = "ticket" | "charter" | "add_on" | "fee" | "discount";

type Insert<T> = ColumnType<T, T, never>;
type InsertDefault<T> = ColumnType<T, T | undefined, never>;
/** Stamped by a trigger on insert; never written or read by application code. */
type CreatedTxid = ColumnType<string, never, never>;
interface TermsAuthor {
  created_at: CreatedAt;
  actor_type: InsertDefault<TermsActorType>;
  actor_id: InsertDefault<string | null>;
  request_id: InsertDefault<string | null>;
}

export interface PriceListVersionsTable extends TermsAuthor {
  tenant_id: TenantColumn;
  product_id: Insert<string>;
  version: Insert<number>;
  product_kind: Insert<ProductKind>;
  currency: InsertDefault<"USD">;
  created_txid: CreatedTxid;
  reason: Insert<string>;
}

export interface PriceListItemsTable {
  tenant_id: TenantColumn;
  product_id: Insert<string>;
  version: Insert<number>;
  product_kind: Insert<ProductKind>;
  item_kind: Insert<PriceItemKind>;
  code: Insert<string>;
  name: Insert<string>;
  unit_amount: Insert<number>;
  taxable: Insert<boolean>;
  basis: InsertDefault<ChargeBasis | null>;
  max_quantity: InsertDefault<number | null>;
  /** Local dates; see DateColumn. Add-ons only. */
  available_from: ColumnType<Date | null, string | null | undefined, never>;
  available_until: ColumnType<Date | null, string | null | undefined, never>;
  sort_order: Insert<number>;
}

export interface PolicyVersionsTable extends TermsAuthor {
  tenant_id: TenantColumn;
  product_id: Insert<string>;
  version: Insert<number>;
  change_cutoff_minutes: Insert<number>;
  before_cutoff_remedy: Insert<PolicyRemedy>;
  before_cutoff_refund_bp: InsertDefault<number | null>;
  after_cutoff_remedy: Insert<PolicyRemedy>;
  after_cutoff_refund_bp: InsertDefault<number | null>;
  no_show_remedy: Insert<PolicyRemedy>;
  no_show_refund_bp: InsertDefault<number | null>;
  cancellation_text: Insert<string>;
  reschedule_text: Insert<string>;
  no_show_text: Insert<string>;
  operator_cancellation_text: Insert<string>;
  weather_text: Insert<string>;
  reason: Insert<string>;
}

export interface TaxRateVersionsTable extends TermsAuthor {
  tenant_id: TenantColumn;
  tax_rate_id: Insert<string>;
  version: Insert<number>;
  name: Insert<string>;
  rate_ppm: Insert<number>;
  inclusive: Insert<boolean>;
  active: Insert<boolean>;
  reason: Insert<string>;
  /** The location whose departures this version applies to; null for every location (0024). */
  location_id: ColumnType<string | null, string | null | undefined, never>;
}

export interface PromotionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  /** Upper case; unique per tenant. */
  code: Insert<string>;
  created_at: CreatedAt;
  actor_type: InsertDefault<TermsActorType>;
  actor_id: InsertDefault<string | null>;
  request_id: InsertDefault<string | null>;
}

export interface PromotionVersionsTable extends TermsAuthor {
  tenant_id: TenantColumn;
  promotion_id: Insert<string>;
  version: Insert<number>;
  discount_kind: Insert<DiscountKind>;
  amount_off: InsertDefault<number | null>;
  percent_off_bp: InsertDefault<number | null>;
  currency: InsertDefault<"USD">;
  starts_at: Instant;
  ends_at: Instant;
  applies_to_all_products: Insert<boolean>;
  active: Insert<boolean>;
  created_txid: CreatedTxid;
  reason: Insert<string>;
}

export interface PromotionVersionProductsTable {
  tenant_id: TenantColumn;
  promotion_id: Insert<string>;
  version: Insert<number>;
  product_id: Insert<string>;
}

export interface QuotesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  trip_id: Insert<string>;
  product_id: Insert<string>;
  product_kind: Insert<ProductKind>;
  product_name: Insert<string>;
  trip_time_zone: Insert<string>;
  trip_local_date: DateColumn;
  /** "HH:MM:SS". */
  trip_local_start_time: Insert<string>;
  trip_starts_at: Instant;
  trip_start_utc_offset_minutes: Insert<number>;
  price_list_version: Insert<number>;
  policy_version: Insert<number>;
  promotion_id: InsertDefault<string | null>;
  promotion_version: InsertDefault<number | null>;
  currency: InsertDefault<"USD">;
  party_size: Insert<number>;
  subtotal_amount: Insert<number>;
  discount_amount: Insert<number>;
  fee_amount: Insert<number>;
  tax_amount: Insert<number>;
  included_tax_amount: Insert<number>;
  total_amount: Insert<number>;
  quoted_at: Instant;
  expires_at: Instant;
  created_at: CreatedAt;
  created_txid: CreatedTxid;
  actor_type: InsertDefault<ActorType>;
  actor_id: InsertDefault<string | null>;
  request_id: InsertDefault<string | null>;
}

export interface QuoteLinesTable {
  tenant_id: TenantColumn;
  quote_id: Insert<string>;
  line_no: Insert<number>;
  kind: Insert<QuoteLineKind>;
  code: Insert<string>;
  name: Insert<string>;
  basis: InsertDefault<ChargeBasis | null>;
  quantity: Insert<number>;
  unit_amount: Insert<number>;
  amount: Insert<number>;
  discount_amount: InsertDefault<number>;
  taxable: Insert<boolean>;
}

export interface QuoteLineTaxesTable {
  tenant_id: TenantColumn;
  quote_id: Insert<string>;
  line_no: Insert<number>;
  tax_rate_id: Insert<string>;
  tax_rate_version: Insert<number>;
  taxable_amount: Insert<number>;
  amount: Insert<number>;
}

/** Tables added by migration 0005, merged into Database below. */
interface PricingTables {
  price_list_versions: PriceListVersionsTable;
  price_list_items: PriceListItemsTable;
  policy_versions: PolicyVersionsTable;
  tax_rate_versions: TaxRateVersionsTable;
  promotions: PromotionsTable;
  promotion_versions: PromotionVersionsTable;
  promotion_version_products: PromotionVersionProductsTable;
  quotes: QuotesTable;
  quote_lines: QuoteLinesTable;
  quote_line_taxes: QuoteLineTaxesTable;
}

// Capacity and holds (G2.6). The trigger sets kind, seats, and every
// timestamp but expires_at, which the writer gives at insert and which can
// only move earlier; the runtime may update state only.

export type HoldState = "active" | "confirmed" | "released" | "expired";
export type HoldKind = "seats" | "whole_boat";

export interface CapacityHoldsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  trip_id: Fixed<string>;
  /** Opaque owner, "<type>:<id>", such as "checkout_session:<uuid>". */
  owner_ref: Fixed<string>;
  /** seats on a shared-seat trip, whole_boat on a private charter; set by the database. */
  kind: ColumnType<HoldKind, never, never>;
  party_size: Fixed<number>;
  /** Capacity taken: the party size, or every seat for a whole boat; set by the database. */
  seats: ColumnType<number, never, never>;
  state: ColumnType<HoldState, "active" | undefined, HoldState>;
  expires_at: ColumnType<Date, Date | string, never>;
  created_at: CreatedAt;
  confirmed_at: ColumnType<Date | null, never, never>;
  released_at: ColumnType<Date | null, never, never>;
  expired_at: ColumnType<Date | null, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// Checkout, orders, payments, the provider-event inbox, and bookings (G2.7).
// Triggers stamp every timestamp and enforce the one-way states; columns typed
// `never` for update are not granted to the runtime.

export type PaymentProviderName = "fake" | "stripe";
/** unfulfilled: a verified success could not become a booking and is refunded in full. */
export type CheckoutSessionState =
  | "open"
  | "confirmed"
  | "unfulfilled"
  | "failed"
  | "expired"
  | "canceled";
export type OrderStatus = "pending" | "paid" | "void";
export type OrderLineKind = "service" | "add_on" | "fee" | "tax" | "discount";
export type PaymentState = "pending" | "succeeded" | "failed";
/** pending: the provider accepted the refund and has not finished it (0028, W3-G2.9). */
export type RefundState = "requested" | "pending" | "succeeded" | "failed";
export type RefundReason = "unfulfilled_payment" | "booking_canceled";
export type BookingState = "confirmed" | "canceled";
/**
 * Where a booking came from (G2.12d). The database stamps it from the
 * transaction's actor on the checkout, and copies it to the booking; no
 * writer chooses it.
 */
export type BookingSource = "direct" | "staff_assisted";
/** How a guest reached the staff member who opened a staff-assisted checkout (G2.12d). */
export type BookingChannel = "phone" | "email" | "walk_up";
export type ProviderEventType =
  | "payment.succeeded"
  | "payment.failed"
  /** A refund the provider reports on (0028, W3-G2.9). */
  | "refund.updated"
  | "other";
/** A refund's status as a provider event reports it (0028). */
export type ProviderRefundStatus = "pending" | "succeeded" | "failed";
export type InboxProcessingState = "received" | "processed";
export type FinalizationReason =
  | "no_capacity"
  | "trip_canceled"
  | "trip_unavailable"
  | "sales_closed"
  | "party_size_out_of_range"
  | "session_failed"
  | "session_canceled"
  | "payment_mismatch"
  | "session_redacted";
type Stamp = ColumnType<Date | null, never, never>;
type Stamped = ColumnType<Date, never, never>;

/** Written by onboarding (the seed); the runtime may only read it. */
export interface PaymentAccountsTable {
  tenant_id: ColumnType<string, never, never>;
  provider: ColumnType<PaymentProviderName, never, never>;
  account_ref: ColumnType<string, never, never>;
  status: ColumnType<"active" | "disabled", never, never>;
  created_at: CreatedAt;
}

export interface ProviderEventsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  provider: Fixed<PaymentProviderName>;
  event_id: Fixed<string>;
  event_type: Fixed<ProviderEventType>;
  provider_type: Fixed<string>;
  account_ref: Fixed<string>;
  payment_ref: FixedDefault<string | null>;
  client_reference: FixedDefault<string | null>;
  amount: FixedDefault<number | null>;
  currency: FixedDefault<string | null>;
  provider_created_at: ColumnType<Date | null, Date | string | null | undefined, never>;
  payload_sha256: Fixed<string>;
  verified_at: Stamped;
  processing_state: ColumnType<InboxProcessingState, "received" | undefined, InboxProcessingState>;
  outcome: ColumnType<string | null, never, string | null>;
  processed_at: Stamp;
  // Refund events (0028, W3-G2.9).
  refund_ref: FixedDefault<string | null>;
  refund_status: FixedDefault<ProviderRefundStatus | null>;
  refund_key: FixedDefault<string | null>;
  refund_failure_code: FixedDefault<string | null>;
}

export interface CheckoutSessionsTable {
  /** Chosen by the service before the hold, whose owner is "checkout_session:<id>". */
  id: Fixed<string>;
  tenant_id: TenantColumn;
  quote_id: Fixed<string>;
  trip_id: Fixed<string>;
  party_size: Fixed<number>;
  hold_id: Fixed<string>;
  policy_version: Fixed<number>;
  state: ColumnType<CheckoutSessionState, "open" | undefined, CheckoutSessionState>;
  /** Copied from the hold in SQL; never round-tripped through a JavaScript Date. */
  expires_at: ColumnType<Date, Date | string, never>;
  secret_hash: Fixed<string>;
  client_key: FixedDefault<string | null>;
  booker_name: Fixed<string>;
  booker_email: Fixed<string>;
  /** Stamped from the transaction's actor (0012); never chosen by a writer. */
  source: ColumnType<BookingSource, never, never>;
  /** Required on a staff-assisted checkout and null otherwise (0012). */
  channel: FixedDefault<BookingChannel | null>;
  /** The staff member who opened it, stamped from the actor (0012); null when direct. */
  opened_by: ColumnType<string | null, never, never>;
  created_at: Stamped;
  confirmed_at: Stamp;
  unfulfilled_at: Stamp;
  failed_at: Stamp;
  expired_at: Stamp;
  canceled_at: Stamp;
  updated_at: Stamped;
  /** Set only by the retention job (W3-G2.2b); the booker is then the fixed redaction. */
  booker_redacted_at: ColumnType<Date | null, never, never>;
}

export interface OrdersTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  checkout_session_id: Fixed<string>;
  quote_id: Fixed<string>;
  trip_id: Fixed<string>;
  product_id: Fixed<string>;
  party_size: Fixed<number>;
  policy_version: Fixed<number>;
  currency: FixedDefault<"USD">;
  subtotal_amount: Fixed<number>;
  discount_amount: Fixed<number>;
  fee_amount: Fixed<number>;
  tax_amount: Fixed<number>;
  included_tax_amount: Fixed<number>;
  total_amount: Fixed<number>;
  status: ColumnType<OrderStatus, "pending" | undefined, OrderStatus>;
  created_at: Stamped;
  created_txid: CreatedTxid;
  paid_at: Stamp;
  voided_at: Stamp;
  updated_at: Stamped;
}

export interface OrderLinesTable {
  tenant_id: TenantColumn;
  order_id: Fixed<string>;
  line_no: Fixed<number>;
  kind: Fixed<OrderLineKind>;
  code: Fixed<string>;
  name: Fixed<string>;
  basis: FixedDefault<ChargeBasis | null>;
  quantity: Fixed<number>;
  unit_amount: Fixed<number>;
  amount: Fixed<number>;
  discount_amount: FixedDefault<number>;
  taxable: Fixed<boolean>;
  tax_rate_id: FixedDefault<string | null>;
  tax_rate_version: FixedDefault<number | null>;
  tax_inclusive: FixedDefault<boolean | null>;
  taxable_amount: FixedDefault<number | null>;
}

export interface PaymentsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  checkout_session_id: Fixed<string>;
  order_id: Fixed<string>;
  provider: Fixed<PaymentProviderName>;
  account_ref: Fixed<string>;
  idempotency_key: Fixed<string>;
  /** Recorded once, after the provider call returns. */
  provider_payment_id: ColumnType<string | null, never, string>;
  amount: Fixed<number>;
  currency: FixedDefault<"USD">;
  state: ColumnType<PaymentState, "pending" | undefined, PaymentState>;
  succeeded_event_id: ColumnType<string | null, never, string>;
  failed_event_id: ColumnType<string | null, never, string>;
  created_at: Stamped;
  provider_recorded_at: Stamp;
  succeeded_at: Stamp;
  failed_at: Stamp;
  updated_at: Stamped;
}

export interface PaymentRefundsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  payment_id: Fixed<string>;
  amount: Fixed<number>;
  currency: FixedDefault<"USD">;
  /** unfulfilled_payment (G2.7); booking_canceled, a guest's cancellation within policy (G2.11c). */
  reason: Fixed<RefundReason>;
  idempotency_key: Fixed<string>;
  provider_refund_id: ColumnType<string | null, never, string>;
  state: ColumnType<RefundState, "requested" | undefined, RefundState>;
  failure_code: ColumnType<string | null, never, string>;
  created_at: Stamped;
  settled_at: Stamp;
  updated_at: Stamped;
  /** The last time the provider gave no final answer (0028); stamped by the database. */
  checked_at: ColumnType<Date | null, never, Date | string>;
}

export interface BookingsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  reference: Fixed<string>;
  checkout_session_id: Fixed<string>;
  order_id: Fixed<string>;
  payment_id: Fixed<string>;
  hold_id: Fixed<string>;
  trip_id: Fixed<string>;
  party_size: Fixed<number>;
  /** Copied from its checkout by a trigger (0012), whatever the insert names. */
  source: FixedDefault<BookingSource>;
  /** Created confirmed; canceled once, with its cancellation (G2.11c). */
  state: ColumnType<BookingState, "confirmed" | undefined, "canceled">;
  reacquired: Fixed<boolean>;
  confirmed_at: Stamped;
  created_at: Stamped;
  canceled_at: Stamp;
}

export interface FinalizationExceptionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  checkout_session_id: Fixed<string>;
  payment_id: Fixed<string>;
  provider_event_id: Fixed<string>;
  reason: Fixed<FinalizationReason>;
  refund_id: FixedDefault<string | null>;
  created_at: Stamped;
}

export interface FakeProviderPaymentsTable {
  id: Fixed<string>;
  tenant_id: TenantColumn;
  provider: FixedDefault<"fake">;
  account_ref: Fixed<string>;
  amount: Fixed<number>;
  currency: Fixed<"USD">;
  idempotency_key: Fixed<string>;
  client_reference: Fixed<string>;
  created_at: CreatedAt;
}

export interface FakeProviderEventsTable {
  id: Fixed<string>;
  tenant_id: TenantColumn;
  payment_id: Fixed<string>;
  type: Fixed<"payment.succeeded" | "payment.failed">;
  /** The exact JSON text delivered, so a redelivery is byte for byte the same. */
  body: Fixed<string>;
  created_at: CreatedAt;
}

export interface FakeProviderRefundsTable {
  id: Fixed<string>;
  tenant_id: TenantColumn;
  payment_id: Fixed<string>;
  amount: Fixed<number>;
  idempotency_key: Fixed<string>;
  created_at: CreatedAt;
}

/** Tables added by the checkout migration (G2.7), merged into Database below. */
interface CheckoutTables {
  payment_accounts: PaymentAccountsTable;
  provider_events: ProviderEventsTable;
  checkout_sessions: CheckoutSessionsTable;
  orders: OrdersTable;
  order_lines: OrderLinesTable;
  payments: PaymentsTable;
  payment_refunds: PaymentRefundsTable;
  bookings: BookingsTable;
  finalization_exceptions: FinalizationExceptionsTable;
  fake_provider_payments: FakeProviderPaymentsTable;
  fake_provider_events: FakeProviderEventsTable;
  fake_provider_refunds: FakeProviderRefundsTable;
}

// Guest self-service (lane 1, G2.11c): participants and cancellations. -------------
// Triggers stamp the times and check the evidence; columns typed `never` for
// update are not granted to the runtime.

/** One person at one place in a booking's party. Personal data. */
export interface BookingParticipantsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  /** 1 to the booking's party size; unique per booking. */
  position: Fixed<number>;
  full_name: string;
  is_minor: boolean;
  email: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
  created_at: Stamped;
  updated_at: Stamped;
}

export type CancellationRemedy = "full_refund" | "percent_refund" | "credit" | "none";

/** One per booking, append-only: the remedy its policy version gave. */
export interface BookingCancellationsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  payment_id: Fixed<string>;
  product_id: Fixed<string>;
  policy_version: Fixed<number>;
  departs_at: Instant;
  cutoff_at: Instant;
  before_cutoff: Fixed<boolean>;
  remedy: Fixed<CancellationRemedy>;
  refund_bp: Fixed<number>;
  paid_amount: Fixed<number>;
  refund_amount: Fixed<number>;
  currency: FixedDefault<"USD">;
  refund_id: FixedDefault<string | null>;
  // Credit, staff choice, and override (0028, W3-G2.9).
  credit_amount: FixedDefault<number>;
  credit_entry_id: FixedDefault<string | null>;
  /** Stamped by the trigger: the remedy the policy gave. Null before 0028. */
  policy_remedy: ColumnType<PolicyRemedy | null, never, never>;
  policy_refund_bp: ColumnType<number | null, never, never>;
  override_reason: FixedDefault<string | null>;
  created_at: Stamped;
  actor_type: ColumnType<ActorType, never, never>;
  actor_id: ColumnType<string | null, never, never>;
  request_id: ColumnType<string | null, never, never>;
}

export type EmailMessageState = "queued" | "sending" | "sent" | "failed" | "canceled";
export type EmailProviderName = "fake" | "cloudflare";
export type AccessPurpose = "booking_manage" | "waiver_sign";
export type AccessRevocationReason =
  | "superseded"
  | "completed"
  | "withdrawn"
  | "recipient_changed"
  | "booking_canceled"
  | "staff";

/**
 * One transactional email (lane 1, G2.16 shim). Content is fixed at insert;
 * only the delivery columns move, as the trigger allows.
 */
export interface EmailMessagesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  dedupe_key: Fixed<string>;
  template: Fixed<string>;
  template_version: Fixed<number>;
  booking_id: FixedDefault<string | null>;
  participant_id: FixedDefault<string | null>;
  subject_ref: FixedDefault<string | null>;
  to_email: Fixed<string>;
  to_name: FixedDefault<string | null>;
  from_name: Fixed<string>;
  reply_to: FixedDefault<string | null>;
  subject: Fixed<string>;
  html_body: Fixed<string>;
  text_body: Fixed<string>;
  link_purpose: FixedDefault<AccessPurpose | null>;
  link_path: FixedDefault<string | null>;
  link_ttl_seconds: FixedDefault<number | null>;
  link_slot: FixedDefault<string | null>;
  state: ColumnType<EmailMessageState, "queued" | undefined, EmailMessageState>;
  attempts: ColumnType<number, 0 | undefined, number>;
  next_attempt_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** When the latest attempt was claimed; stamped by the trigger. */
  last_attempt_at: Stamp;
  lease_expires_at: ColumnType<Date | null, never, Date | string | null>;
  provider: ColumnType<EmailProviderName | null, never, EmailProviderName | null>;
  provider_message_id: ColumnType<string | null, never, string | null>;
  last_error_code: ColumnType<string | null, never, string | null>;
  created_at: Stamped;
  sent_at: Stamp;
  failed_at: Stamp;
  canceled_at: Stamp;
  updated_at: Stamped;
}

/** An accountless access link; only the token's SHA-256 is stored. */
export interface GuestAccessLinksTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  participant_id: FixedDefault<string | null>;
  purpose: Fixed<AccessPurpose>;
  subject_ref: FixedDefault<string | null>;
  message_id: FixedDefault<string | null>;
  token_hash: Fixed<string>;
  created_at: Stamped;
  expires_at: Instant;
  consumed_at: ColumnType<Date | null, never, Date | string>;
  revoked_at: ColumnType<Date | null, never, Date | string>;
  revoked_reason: ColumnType<AccessRevocationReason | null, never, AccessRevocationReason>;
}

/** The restricted session a redeemed link opens; only the token's SHA-256 is stored. */
export interface GuestSessionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  participant_id: FixedDefault<string | null>;
  purpose: Fixed<AccessPurpose>;
  subject_ref: FixedDefault<string | null>;
  link_id: FixedDefault<string | null>;
  checkout_session_id: FixedDefault<string | null>;
  token_hash: Fixed<string>;
  created_at: Stamped;
  expires_at: Instant;
  revoked_at: ColumnType<Date | null, never, Date | string>;
}

/** The fake email provider's record of every send it answered; append-only. */
export interface FakeEmailDeliveriesTable {
  id: Fixed<string>;
  tenant_id: TenantColumn;
  idempotency_key: Fixed<string>;
  result: Fixed<"accepted" | "unavailable" | "rejected">;
  from_address: Fixed<string>;
  from_name: Fixed<string>;
  reply_to: FixedDefault<string | null>;
  to_address: Fixed<string>;
  to_name: FixedDefault<string | null>;
  subject: Fixed<string>;
  html_body: Fixed<string>;
  text_body: Fixed<string>;
  created_at: CreatedAt;
}

interface SelfServiceTables {
  booking_participants: BookingParticipantsTable;
  booking_cancellations: BookingCancellationsTable;
  email_messages: EmailMessagesTable;
  guest_access_links: GuestAccessLinksTable;
  guest_sessions: GuestSessionsTable;
  fake_email_deliveries: FakeEmailDeliveriesTable;
}

// Console completion (G2.12c) ------------------------------------------------------

/**
 * An internal note on a booking. Append-only for every role; a trigger sets
 * the author, request, and time from the transaction, so an insert names only
 * the tenant, the booking, and the body.
 */
export interface BookingNotesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  body: Fixed<string>;
  author_user_id: ColumnType<string, never, never>;
  request_id: ColumnType<string | null, never, never>;
  created_at: CreatedAt;
}

// Finalization exception resolutions (0018, W1-FIN-EXC) ----------------------------

export type ExceptionResolutionReason =
  | "contacted_guest"
  | "refunded_outside"
  | "no_action_needed"
  | "other";

/**
 * Staff marked a finalization exception as followed up. One per exception,
 * append-only for every role; a trigger sets who resolved it, the request,
 * and the time from the transaction, so an insert names only the tenant, the
 * exception, the reason code, and the note.
 */
export interface FinalizationExceptionResolutionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  exception_id: Fixed<string>;
  reason_code: Fixed<ExceptionResolutionReason>;
  note: ColumnType<string | null, string | null | undefined, never>;
  resolved_by_user_id: ColumnType<string, never, never>;
  request_id: ColumnType<string | null, never, never>;
  created_at: CreatedAt;
}

export type EmailEventType = "bounced" | "complained";

/**
 * Append-only (0021, W1-EMAIL-EVENTS). A trigger joins each row to the
 * tenant's own sent message and stamps received_at. The platform table
 * email_events_unmatched is not here: the runtime reaches it only through
 * app.record_unmatched_email_event.
 */
export interface EmailEventsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  provider: Fixed<"cloudflare">;
  event_id: Fixed<string>;
  event_type: Fixed<EmailEventType>;
  provider_message_id: Fixed<string>;
  message_id: Fixed<string>;
  bounce_type: ColumnType<"hard" | "soft" | null, "hard" | "soft" | null | undefined, never>;
  detail_code: ColumnType<string | null, string | null | undefined, never>;
  occurred_at: ColumnType<Date, Date | string, never>;
  received_at: ColumnType<Date, never, never>;
  applied: Fixed<boolean>;
}

export type SenderDomainStatus = "pending" | "verified" | "retired";

/**
 * Read only for the runtime (0027, W3-G2.16-rest): the admin connection adds,
 * verifies, and retires a domain through app.sender_domain_* functions.
 */
export interface TenantSenderDomainsTable {
  id: ColumnType<string, never, never>;
  tenant_id: ColumnType<string, never, never>;
  domain: ColumnType<string, never, never>;
  local_part: ColumnType<string, never, never>;
  status: ColumnType<SenderDomainStatus, never, never>;
  verified_at: ColumnType<Date | null, never, never>;
  retired_at: ColumnType<Date | null, never, never>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export type EmailSuppressionReason = "hard_bounce" | "complaint";

/**
 * One operator's suppressed addresses (0027). A trigger joins each row to the
 * tenant's own complaint or hard bounce and that message's address; only the
 * admin connection lifts one, through app.email_suppression_lift.
 */
export interface EmailSuppressionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  address: Fixed<string>;
  reason: Fixed<EmailSuppressionReason>;
  event_id: Fixed<string>;
  created_at: ColumnType<Date, never, never>;
  lifted_at: ColumnType<Date | null, never, never>;
  lift_reason: ColumnType<string | null, never, never>;
}

/** Tables added by the console completion migration (G2.12c), merged into Database below. */
interface ConsoleTables {
  booking_notes: BookingNotesTable;
}

// Waiver evidence (G2.15). Triggers stamp every time and enforce the one-way
// states; columns typed `never` for update are not granted to the runtime.

export type WaiverTemplateScope = "operator" | "product";
export type WaiverSignerRole = "participant" | "guardian";
export type WaiverRequestState = "pending" | "signed" | "revoked" | "superseded";
export type WaiverRevokedReason =
  | "participant_removed"
  | "participant_changed"
  | "booking_canceled";
export type WaiverSessionRevokedReason =
  | WaiverRevokedReason
  | "superseded"
  | "recipient_changed"
  /** Another session of the request, when the request was signed. */
  | "completed"
  /** Its own page ended it: the shared-device cleanup (0020). */
  | "signed_out";
export type WaiverDeliveryKind = "initial" | "resend";
export type GuardianRelationship = "parent" | "legal_guardian";

export interface WaiverTemplatesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  scope: Fixed<WaiverTemplateScope>;
  product_id: FixedDefault<string | null>;
  name: Fixed<string>;
  created_at: Stamped;
  actor_type: ColumnType<"staff" | "system" | "support", never, never>;
  actor_id: ColumnType<string | null, never, never>;
  request_id: ColumnType<string | null, never, never>;
  reason: Fixed<string>;
}

export interface WaiverTemplateVersionsTable {
  tenant_id: TenantColumn;
  template_id: Fixed<string>;
  version: Fixed<number>;
  title: Fixed<string>;
  body: Fixed<string>;
  acknowledgments: Fixed<string[]>;
  rendering_version: Fixed<number>;
  adult_signer: FixedDefault<"participant">;
  minor_signer: FixedDefault<"guardian">;
  resign_policy: FixedDefault<"every_booking">;
  /** Never earlier than the moment the version is written; the database moves it. */
  effective_from: ColumnType<Date, Date | string, never>;
  effective_until: ColumnType<Date | null, Date | string | null | undefined, never>;
  /** Computed by the database from the canonical content. */
  content_sha256: ColumnType<string, never, never>;
  created_at: Stamped;
  actor_type: ColumnType<"staff" | "system" | "support", never, never>;
  actor_id: ColumnType<string | null, never, never>;
  request_id: ColumnType<string | null, never, never>;
  reason: Fixed<string>;
}

export interface WaiverRequestsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  participant_id: Fixed<string>;
  template_id: Fixed<string>;
  template_version: Fixed<number>;
  content_sha256: Fixed<string>;
  required_signer: Fixed<WaiverSignerRole>;
  state: ColumnType<WaiverRequestState, "pending" | undefined, WaiverRequestState>;
  revoked_reason: ColumnType<WaiverRevokedReason | null, never, WaiverRevokedReason>;
  superseded_by: ColumnType<string | null, never, string>;
  created_at: Stamped;
  signed_at: Stamp;
  revoked_at: Stamp;
  superseded_at: Stamp;
  updated_at: Stamped;
}

export interface WaiverDeliveriesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  request_id: Fixed<string>;
  generation: Fixed<number>;
  kind: Fixed<WaiverDeliveryKind>;
  recipient_email: Fixed<string>;
  /** The waiver message this generation queued (email_messages). */
  message_id: Fixed<string>;
  created_at: Stamped;
  /** When the email may first go out; never before the insert. Its message is due no earlier. */
  send_after: FixedDefault<Date>;
  actor_type: ColumnType<ActorType, never, never>;
  actor_id: ColumnType<string | null, never, never>;
  api_request_id: ColumnType<string | null, never, never>;
  reason: FixedDefault<string | null>;
  /** A generation the guest asked for themselves (0028, W1-WAIVER-RENEWAL D1). */
  guest_renewal: FixedDefault<boolean>;
}

export interface WaiverSigningSessionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  /** The waiver link (guest_access_links) whose redemption opened it. */
  access_link_id: Fixed<string>;
  request_id: Fixed<string>;
  booking_id: Fixed<string>;
  participant_id: Fixed<string>;
  purpose: Fixed<"sign">;
  signer_role: Fixed<WaiverSignerRole>;
  secret_hash: Fixed<string>;
  created_at: Stamped;
  expires_at: ColumnType<Date, Date | string, never>;
  revoked_at: ColumnType<Date | null, never, Date | string>;
  revoked_reason: ColumnType<WaiverSessionRevokedReason | null, never, WaiverSessionRevokedReason>;
}

export interface WaiverEvidenceTable {
  id: ColumnType<string, string | undefined, never>;
  tenant_id: TenantColumn;
  request_id: Fixed<string>;
  booking_id: Fixed<string>;
  participant_id: Fixed<string>;
  session_id: Fixed<string>;
  template_id: Fixed<string>;
  template_version: Fixed<number>;
  content_sha256: Fixed<string>;
  rendering_version: Fixed<number>;
  participant_name: Fixed<string>;
  participant_minor: Fixed<boolean>;
  signer_role: Fixed<WaiverSignerRole>;
  signer_name: Fixed<string>;
  guardian_relationship: FixedDefault<GuardianRelationship | null>;
  signature_method: Fixed<"typed_name">;
  signature_text: Fixed<string>;
  acknowledgments: Fixed<string[]>;
  consent_version: Fixed<string>;
  consent_text: Fixed<string>;
  access_method: Fixed<WaiverAccessMethod>;
  /** The address an email link went to; null for a staff-assisted signing (0020). */
  recipient_email: FixedDefault<string | null>;
  match_method: Fixed<WaiverMatchMethod>;
  /** The staff member who started a staff-assisted signing; null for an email link (0020). */
  assisted_by: FixedDefault<string | null>;
  /** Stamped by the database: the signing transaction's own clock. */
  signed_at: Stamped;
  source_ip: FixedDefault<string | null>;
  user_agent: FixedDefault<string | null>;
  document: Fixed<Uint8Array>;
  document_sha256: Fixed<string>;
}

/** How a signer reached the waiver: an emailed link, or a staff-assisted start (0020). */
export type WaiverAccessMethod = "email_link" | "staff_device" | "participant_qr";
export type WaiverAssistedMode = Exclude<WaiverAccessMethod, "email_link">;
/** Who confirmed the signer: the signer alone, or a staff member who checked them too (0020). */
export type WaiverMatchMethod = "signer_confirmed" | "staff_confirmed";

/** A staff-assisted signing start (0020): append-only for every role. */
export interface WaiverAssistedLinksTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  /** The waiver link with no email that it issued (guest_access_links). */
  access_link_id: Fixed<string>;
  request_id: Fixed<string>;
  booking_id: Fixed<string>;
  participant_id: Fixed<string>;
  mode: Fixed<WaiverAssistedMode>;
  identity_checked: Fixed<boolean>;
  created_at: Stamped;
  actor_type: ColumnType<"staff", never, never>;
  actor_id: ColumnType<string, never, never>;
  api_request_id: ColumnType<string | null, never, never>;
}

export type WaiverReminderSlot = "72h" | "24h";

/** A reminder email for an unsigned waiver (0025, W1-G215-REMINDERS). Append-only. */
export interface WaiverRemindersTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  request_id: Fixed<string>;
  booking_id: Fixed<string>;
  participant_id: Fixed<string>;
  slot: Fixed<WaiverReminderSlot>;
  message_id: Fixed<string>;
  recipient_email: Fixed<string>;
  created_at: Stamped;
}

/** A staff reset of a waiver request's five sends (0028): five more may follow. */
export interface WaiverSendResetsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  request_id: Fixed<string>;
  after_generation: Fixed<number>;
  actor_id: Fixed<string>;
  reason: Fixed<string>;
  created_at: Stamped;
}

/** Tables added by the waiver migration (G2.15), merged into Database below. */
interface WaiverTables {
  waiver_templates: WaiverTemplatesTable;
  waiver_template_versions: WaiverTemplateVersionsTable;
  waiver_requests: WaiverRequestsTable;
  waiver_deliveries: WaiverDeliveriesTable;
  waiver_signing_sessions: WaiverSigningSessionsTable;
  waiver_evidence: WaiverEvidenceTable;
  waiver_assisted_links: WaiverAssistedLinksTable;
  waiver_reminders: WaiverRemindersTable;
  waiver_send_resets: WaiverSendResetsTable;
}

/** The cron's cross-tenant sweeps that take fair turns (0013). */
export type SweepName = "hold" | "checkout" | "email" | "hostname" | "outbox" | "waiver_reminder";

/**
 * When a sweep last started a turn for a tenant (0013, pre-pilot hardening).
 * The runtime inserts the row and may move only the time and the run id.
 * Housekeeping: no audit or outbox row. Nobody deletes one.
 */
export interface SweepTurnsTable {
  tenant_id: TenantColumn;
  sweep: Fixed<SweepName>;
  last_turn_at: ColumnType<Date, Date | string | undefined, Date | string>;
  run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** The email a staff resend sends again (G2.16b). */
export type BookingResendKind = "confirmation" | "cancellation";

/**
 * One staff resend of a booking's email (0014, G2.16b follow-up): append-only
 * for every role. A trigger stamps the time and the actor, takes the tenant's
 * resend lock, checks the generation and the message this transaction queued
 * for it, and holds the limits for every writer.
 */
export interface BookingEmailResendsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  /** 1 plus the booking's highest; the last part of its message's key. */
  generation: Fixed<number>;
  kind: Fixed<BookingResendKind>;
  /** The booking.resend: message the same transaction queued (email_messages). */
  message_id: Fixed<string>;
  created_at: Stamped;
  actor_type: ColumnType<ActorType, never, never>;
  actor_id: ColumnType<string | null, never, never>;
  api_request_id: ColumnType<string | null, never, never>;
}

/**
 * One claim of a staff resend message (0017): the claim guard writes it when
 * the delivery job, or any writer, claims a booking.resend: message. The
 * trigger stamps claimed_at at the clock. Append-only.
 */
export interface BookingEmailResendClaimsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  booking_id: Fixed<string>;
  message_id: Fixed<string>;
  /** The attempt the claim began (email_messages.attempts after it). */
  attempt: Fixed<number>;
  claimed_at: Stamped;
}

/** An owner's request to close and delete the tenant's account (W3-G2.2b). */
export interface TenantDeletionRequestsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  /** Inserted as requested; moves once, to withdrawn. */
  state: ColumnType<"requested" | "withdrawn", undefined, "withdrawn">;
  reason: ColumnType<string, string, never>;
  /** The trigger stamps these from the transaction's actor, request, and clock. */
  requested_by: ColumnType<string, never, never>;
  requested_at: ColumnType<Date, never, never>;
  request_id: ColumnType<string | null, never, never>;
  withdrawn_by: ColumnType<string | null, never, never>;
  withdrawn_at: ColumnType<Date | null, never, never>;
}

export interface Database
  extends PricingTables,
    CheckoutTables,
    ConsoleTables,
    SelfServiceTables,
    WaiverTables {
  schema_migrations: SchemaMigrationsTable;
  tenants: TenantsTable;
  tenant_hostnames: TenantHostnamesTable;
  tenant_hostname_provisioning: TenantHostnameProvisioningTable;
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
  brand_config_versions: BrandConfigVersionsTable;
  brand_activations: BrandActivationsTable;
  // Capacity and holds (G2.6).
  capacity_holds: CapacityHoldsTable;
  // Sweep fairness (0013).
  sweep_turns: SweepTurnsTable;
  // Staff resend ledger (0014).
  booking_email_resends: BookingEmailResendsTable;
  booking_email_resend_claims: BookingEmailResendClaimsTable;
  // Finalization exception resolutions (0018, W1-FIN-EXC).
  finalization_exception_resolutions: FinalizationExceptionResolutionsTable;
  // Email bounce and complaint events (0021, W1-EMAIL-EVENTS).
  email_events: EmailEventsTable;
  // Per-operator sender domains and suppression (0027, W3-G2.16-rest).
  tenant_sender_domains: TenantSenderDomainsTable;
  email_suppressions: EmailSuppressionsTable;
  // Delivery foundation (0023, W3-G2.3).
  outbox_deliveries: OutboxDeliveriesTable;
  outbox_dead_letters: OutboxDeadLettersTable;
  // Refunds, credits, and fee reversal (0028, W3-G2.9).
  credit_accounts: CreditAccountsTable;
  credit_entries: CreditEntriesTable;
  fee_ledger_entries: FeeLedgerEntriesTable;
  refund_exceptions: RefundExceptionsTable;
  payment_cancellations: PaymentCancellationsTable;
  // Tenant access remainder (W3-G2.2b).
  tenant_deletion_requests: TenantDeletionRequestsTable;
}

/** One handler's outcome for one outbox event (0023, W3-G2.3). Append-only. */
export interface OutboxDeliveriesTable {
  tenant_id: TenantColumn;
  outbox_event_id: Fixed<string>;
  handler: Fixed<string>;
  processed_at: ColumnType<Date, never, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
}

/** Where a dead letter came from (0023). */
export type DeadLetterSource = "consumer" | "queue" | "publisher";

/**
 * A message that exhausted its retries (0023, W3-G2.3). Written open; a replay
 * sets the reason once and the trigger stamps who and when.
 */
export interface OutboxDeadLettersTable {
  tenant_id: TenantColumn;
  id: BigIntId;
  outbox_event_id: Fixed<string>;
  topic: Fixed<string>;
  handler: Fixed<string | null>;
  error_code: Fixed<string>;
  attempts: Fixed<number>;
  source: Fixed<DeadLetterSource>;
  dead_lettered_at: ColumnType<Date, never, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  replayed_at: ColumnType<Date | null, never, never>;
  replayed_by: ColumnType<string | null, never, never>;
  replay_reason: ColumnType<string | null, never, string>;
}

/** A named customer's USD booking credit (0028, W3-G2.9). The balance moves only through entries. */
export interface CreditAccountsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  customer_email: Fixed<string>;
  currency: FixedDefault<"USD">;
  balance: ColumnType<number, never, never>;
  /** Entries so far; the trigger numbers each new entry with it. */
  entry_count: ColumnType<number, never, never>;
  created_at: Stamped;
  updated_at: Stamped;
}

export type CreditEntryKind = "issue" | "redeem" | "reinstate" | "adjust";

/** One change to a credit balance (0028). Append-only; the trigger keeps the balance. */
export interface CreditEntriesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  account_id: Fixed<string>;
  kind: Fixed<CreditEntryKind>;
  amount: Fixed<number>;
  balance_after: ColumnType<number, never, never>;
  /** The entry's place in its account's ledger, set by the trigger under the account's lock. */
  seq: ColumnType<number, never, never>;
  currency: FixedDefault<"USD">;
  booking_id: FixedDefault<string | null>;
  cancellation_id: FixedDefault<string | null>;
  reinstates_entry_id: FixedDefault<string | null>;
  expires_at: ColumnType<Date | null, Date | string | null | undefined, never>;
  reason: FixedDefault<string | null>;
  idempotency_key: Fixed<string>;
  created_at: Stamped;
  actor_type: ColumnType<ActorType, never, never>;
  actor_id: ColumnType<string | null, never, never>;
  request_id: ColumnType<string | null, never, never>;
}

/** TideGrid's managed-booking fee ledger (0028). Append-only. */
export interface FeeLedgerEntriesTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  kind: Fixed<"refund_reversal">;
  booking_id: Fixed<string>;
  refund_id: Fixed<string>;
  refund_amount: Fixed<number>;
  order_total: Fixed<number>;
  eligible_total: Fixed<number>;
  eligible_amount: Fixed<number>;
  fee_bp: Fixed<number>;
  fee_amount: Fixed<number>;
  currency: FixedDefault<"USD">;
  created_at: Stamped;
  actor_type: ColumnType<ActorType, never, never>;
  actor_id: ColumnType<string | null, never, never>;
  request_id: ColumnType<string | null, never, never>;
}

export type RefundExceptionReason =
  | "unsettled"
  | "lookup_refused"
  | "failed_after_success"
  | "succeeded_after_failure";

/** A refund that needs a person (0028). One per refund and reason, append-only. */
export interface RefundExceptionsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  refund_id: Fixed<string>;
  reason: Fixed<RefundExceptionReason>;
  refund_state: Fixed<RefundState>;
  error_code: FixedDefault<string | null>;
  created_at: Stamped;
}

export type PaymentCancellationState = "requested" | "canceled" | "too_late" | "refused";

/** An expired or canceled checkout's payment, canceled at the provider (0028). */
export interface PaymentCancellationsTable {
  id: Generated<string>;
  tenant_id: TenantColumn;
  payment_id: Fixed<string>;
  checkout_session_id: Fixed<string>;
  idempotency_key: Fixed<string>;
  state: ColumnType<PaymentCancellationState, "requested" | undefined, PaymentCancellationState>;
  outcome_code: ColumnType<string | null, never, string | null>;
  created_at: Stamped;
  settled_at: Stamp;
  updated_at: Stamped;
}

export type { Generated, GeneratedAlways };
