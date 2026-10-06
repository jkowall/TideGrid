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
export type CheckoutSessionState =
  | "open"
  | "confirmed"
  | "paid"
  | "failed"
  | "expired"
  | "canceled";
export type OrderStatus = "pending" | "paid" | "void";
export type OrderLineKind = "service" | "add_on" | "fee" | "tax" | "discount";
export type PaymentState = "pending" | "succeeded" | "failed";
export type RefundState = "requested" | "succeeded" | "failed";
export type ProviderEventType = "payment.succeeded" | "payment.failed" | "other";
export type InboxProcessingState = "received" | "processed";
export type FinalizationReason =
  | "no_capacity"
  | "trip_canceled"
  | "trip_unavailable"
  | "sales_closed"
  | "party_size_out_of_range"
  | "session_failed"
  | "session_canceled"
  | "payment_mismatch";
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
  created_at: Stamped;
  confirmed_at: Stamp;
  paid_at: Stamp;
  failed_at: Stamp;
  expired_at: Stamp;
  canceled_at: Stamp;
  updated_at: Stamped;
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
  reason: Fixed<"unfulfilled_payment">;
  idempotency_key: Fixed<string>;
  provider_refund_id: ColumnType<string | null, never, string>;
  state: ColumnType<RefundState, "requested" | undefined, RefundState>;
  failure_code: ColumnType<string | null, never, string>;
  created_at: Stamped;
  settled_at: Stamp;
  updated_at: Stamped;
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
  source: FixedDefault<"direct">;
  state: FixedDefault<"confirmed">;
  reacquired: Fixed<boolean>;
  confirmed_at: Stamped;
  created_at: Stamped;
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

export interface Database extends PricingTables, CheckoutTables {
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
  brand_config_versions: BrandConfigVersionsTable;
  brand_activations: BrandActivationsTable;
  // Capacity and holds (G2.6).
  capacity_holds: CapacityHoldsTable;
}

export type { Generated, GeneratedAlways };
