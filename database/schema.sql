-- TideGrid PostgreSQL 17 schema
-- Migration order: extensions and helpers, tenancy, catalog, availability,
-- commerce, stored value, integrations, documents, operations, invariants, RLS.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding','active','suspended','offboarding','closed')),
  default_currency char(3) NOT NULL DEFAULT 'USD',
  default_locale text NOT NULL DEFAULT 'en-US',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE brands (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE legal_entities (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'US',
  tax_identifier_ciphertext bytea,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','restricted','inactive')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE locations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  brand_id uuid,
  legal_entity_id uuid NOT NULL,
  name text NOT NULL,
  iana_time_zone text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities(tenant_id, id)
);

CREATE TABLE provider_accounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('stripe','twilio','email','weather','accounting','ota')),
  environment text NOT NULL CHECK (environment IN ('test','production')),
  external_account_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','restricted','disabled')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (provider, environment, external_account_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities(tenant_id, id)
);

CREATE TABLE users (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_subject text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','active','disabled')),
  mfa_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, external_subject),
  UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  system_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id)
);

CREATE TABLE user_role_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  location_id uuid,
  valid_during tstzrange,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE customers (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text,
  phone_e164 text,
  given_name text NOT NULL,
  family_name text NOT NULL,
  account_subject text,
  locale text NOT NULL DEFAULT 'en-US',
  time_zone text,
  internal_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_into_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES customers(tenant_id, id)
);

CREATE INDEX customers_email_idx ON customers (tenant_id, lower(email))
  WHERE email IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX customers_phone_idx ON customers (tenant_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND merged_into_id IS NULL;

CREATE TABLE participants (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  given_name_ciphertext bytea NOT NULL,
  family_name_ciphertext bytea NOT NULL,
  date_of_birth_ciphertext bytea,
  profile_ciphertext bytea,
  key_version integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE guardians (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  given_name_ciphertext bytea NOT NULL,
  family_name_ciphertext bytea NOT NULL,
  email_ciphertext bytea,
  phone_ciphertext bytea,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE participant_guardians (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  participant_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  relationship text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, participant_id, guardian_id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id),
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians(tenant_id, id)
);

CREATE TABLE emergency_contacts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL,
  name_ciphertext bytea NOT NULL,
  relationship_ciphertext bytea,
  phone_ciphertext bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id)
);

CREATE TABLE products (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL,
  brand_id uuid,
  module_type text NOT NULL
    CHECK (module_type IN ('core','dive','fishing','excursion','private_charter')),
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id)
);

CREATE TABLE product_variants (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  code text NOT NULL,
  inventory_mode text NOT NULL
    CHECK (inventory_mode IN ('shared_seat','private_whole_vessel')),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  pricing_definition jsonb NOT NULL,
  policy_snapshot jsonb NOT NULL,
  requirement_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, product_id, code),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE departure_templates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  recurrence_rule text,
  season_start date,
  season_end date,
  local_departure_time time NOT NULL,
  expected_duration_minutes integer NOT NULL CHECK (expected_duration_minutes > 0),
  preparation_minutes integer NOT NULL DEFAULT 0 CHECK (preparation_minutes >= 0),
  cleanup_minutes integer NOT NULL DEFAULT 0 CHECK (cleanup_minutes >= 0),
  online_cutoff_minutes integer NOT NULL DEFAULT 60 CHECK (online_cutoff_minutes >= 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

CREATE TABLE departure_instances (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid,
  product_variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  local_date date NOT NULL,
  local_departure_time time NOT NULL,
  iana_time_zone text NOT NULL,
  utc_offset_minutes smallint NOT NULL CHECK (utc_offset_minutes BETWEEN -840 AND 840),
  starts_at timestamptz NOT NULL,
  expected_return_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','minimum_not_met','confirmed_to_run','weather_watch','delayed','boarding','departed','returned','closed','cancelled','aborted')),
  minimum_passengers integer NOT NULL DEFAULT 0 CHECK (minimum_passengers >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK (expected_return_at > starts_at),
  UNIQUE (tenant_id, id, starts_at),
  FOREIGN KEY (tenant_id, template_id) REFERENCES departure_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, product_variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

CREATE INDEX departure_instances_schedule_idx
  ON departure_instances (tenant_id, location_id, starts_at);

CREATE TABLE resources (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  location_id uuid,
  resource_type text NOT NULL,
  name text NOT NULL,
  exclusive boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','unavailable','out_of_service','retired')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

CREATE TABLE resource_qualifications (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL,
  qualification_code text NOT NULL,
  restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_during daterange NOT NULL,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected','expired')),
  verified_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES users(tenant_id, id)
);

CREATE INDEX resource_qualifications_lookup_idx
  ON resource_qualifications (tenant_id, resource_id, qualification_code);

CREATE TABLE resource_requirements (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_variant_id uuid,
  departure_id uuid,
  resource_type text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  required_qualification_code text,
  exclusive boolean NOT NULL DEFAULT true,
  substitution_allowed boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT false,
  preparation_minutes integer NOT NULL DEFAULT 0 CHECK (preparation_minutes >= 0),
  cleanup_minutes integer NOT NULL DEFAULT 0 CHECK (cleanup_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((product_variant_id IS NOT NULL) <> (departure_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, product_variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id)
);

CREATE TABLE resource_reservations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL,
  requirement_id uuid,
  departure_id uuid,
  checkout_session_id uuid,
  reservation_kind text NOT NULL
    CHECK (reservation_kind IN ('hold','confirmed','block','option')),
  status text NOT NULL
    CHECK (status IN ('held','confirmed','blocked','released','expired','cancelled')),
  occupied_range tstzrange NOT NULL,
  qualification_code text,
  expires_at timestamptz,
  idempotency_key text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (NOT isempty(occupied_range)),
  CHECK (lower_inc(occupied_range) AND NOT upper_inc(occupied_range)),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id),
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES resource_requirements(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

ALTER TABLE resource_reservations
  ADD CONSTRAINT resource_reservations_no_active_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    occupied_range WITH &&
  )
  WHERE (status IN ('held','confirmed','blocked'));

CREATE INDEX resource_reservations_departure_idx
  ON resource_reservations (tenant_id, departure_id)
  WHERE status IN ('held','confirmed','blocked');

CREATE TABLE capacity_profiles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vessel_id uuid,
  product_variant_id uuid,
  name text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_variant_id) REFERENCES product_variants(tenant_id, id)
);

CREATE TABLE capacity_buckets (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL,
  profile_id uuid,
  dimension_code text NOT NULL,
  limit_quantity numeric(12,3) NOT NULL CHECK (limit_quantity >= 0),
  held_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (held_quantity >= 0),
  confirmed_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (confirmed_quantity >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, departure_id, dimension_code),
  CHECK (held_quantity + confirmed_quantity <= limit_quantity),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES capacity_profiles(tenant_id, id)
);

CREATE TABLE capacity_holds (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  bucket_id uuid NOT NULL,
  checkout_session_id uuid NOT NULL,
  booking_id uuid,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held','confirmed','released','expired','cancelled')),
  expires_at timestamptz NOT NULL,
  command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, command_id),
  UNIQUE (tenant_id, checkout_session_id, bucket_id),
  FOREIGN KEY (tenant_id, bucket_id) REFERENCES capacity_buckets(tenant_id, id)
);

COMMIT;

BEGIN;

CREATE TABLE checkout_sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  departure_id uuid,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','holding','payment_pending','completed','expired','abandoned','exception')),
  quote_snapshot jsonb NOT NULL,
  currency char(3) NOT NULL,
  hold_expires_at timestamptz,
  payment_pending_until timestamptz,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id)
);

ALTER TABLE resource_reservations
  ADD FOREIGN KEY (tenant_id, checkout_session_id)
  REFERENCES checkout_sessions(tenant_id, id);

ALTER TABLE capacity_holds
  ADD FOREIGN KEY (tenant_id, checkout_session_id)
  REFERENCES checkout_sessions(tenant_id, id);

CREATE TABLE bookings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL,
  checkout_session_id uuid,
  primary_booker_customer_id uuid NOT NULL,
  source text NOT NULL
    CHECK (source IN ('online','telephone','walk_up','concierge','affiliate','staff','import','complimentary','promotion')),
  lifecycle_state text NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_state IN ('draft','held','confirmed','partially_cancelled','cancelled_customer','cancelled_operator','rescheduled','completed')),
  service_state text NOT NULL DEFAULT 'not_started'
    CHECK (service_state IN ('not_started','partially_checked_in','checked_in','partially_boarded','boarded','no_show','completed')),
  readiness_state text NOT NULL DEFAULT 'payment_pending'
    CHECK (readiness_state IN ('payment_pending','payment_failed','waiver_incomplete','requirements_incomplete','ready_for_check_in','blocked')),
  financial_state text NOT NULL DEFAULT 'unpaid'
    CHECK (financial_state IN ('unpaid','paid','partially_refunded','fully_refunded','disputed','chargeback_lost')),
  party_size integer NOT NULL CHECK (party_size > 0),
  policy_snapshot jsonb NOT NULL,
  internal_notes text,
  customer_notes text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES checkout_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, primary_booker_customer_id) REFERENCES customers(tenant_id, id)
);

ALTER TABLE capacity_holds
  ADD FOREIGN KEY (tenant_id, booking_id)
  REFERENCES bookings(tenant_id, id);

CREATE TABLE booking_participants (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  passenger_type text NOT NULL,
  state text NOT NULL DEFAULT 'invited'
    CHECK (state IN ('invited','profile_incomplete','requirements_incomplete','ready','checked_in','boarded','no_show','disembarked','removed','replaced')),
  replaced_by_id uuid,
  checked_in_at timestamptz,
  boarded_at timestamptz,
  disembarked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, booking_id, participant_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id),
  FOREIGN KEY (tenant_id, replaced_by_id) REFERENCES booking_participants(tenant_id, id)
);

CREATE TABLE orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_id uuid,
  legal_entity_id uuid NOT NULL,
  provider_account_id uuid,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','open','payment_pending','paid','partially_refunded','refunded','disputed','closed','void')),
  currency char(3) NOT NULL,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  tip_minor bigint NOT NULL DEFAULT 0 CHECK (tip_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  eligible_fee_base_minor bigint NOT NULL CHECK (eligible_fee_base_minor >= 0),
  pricing_plan_code text NOT NULL
    CHECK (pricing_plan_code IN ('dock','growth','fleet','enterprise')),
  pricing_schedule_version text NOT NULL
    CHECK (length(pricing_schedule_version) BETWEEN 1 AND 80),
  platform_fee_rate_basis_points integer NOT NULL
    CHECK (platform_fee_rate_basis_points BETWEEN 75 AND 300),
  source text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK (eligible_fee_base_minor <= total_minor),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES provider_accounts(tenant_id, id)
);

CREATE TABLE order_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  line_type text NOT NULL
    CHECK (line_type IN ('service','package','gift_card','pos','addon','fee','tax','tip','discount','credit','adjustment')),
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_amount_minor bigint NOT NULL,
  total_amount_minor bigint NOT NULL,
  fee_eligible_minor bigint NOT NULL DEFAULT 0 CHECK (fee_eligible_minor >= 0),
  tax_code text,
  source_reference jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK (fee_eligible_minor <= greatest(total_amount_minor, 0)),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);

CREATE TABLE payment_attempts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  provider_account_id uuid,
  payment_method_type text NOT NULL,
  state text NOT NULL DEFAULT 'created'
    CHECK (state IN ('created','requires_method','requires_action','processing','succeeded','failed','cancelled','reconciliation_required')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  idempotency_key text NOT NULL,
  provider_payment_id text,
  provider_charge_id text,
  provider_status text,
  last_provider_event_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE NULLS NOT DISTINCT (tenant_id, provider_account_id, provider_payment_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES provider_accounts(tenant_id, id)
);

CREATE TABLE refunds (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested','approved','submitted','pending','succeeded','failed','cancelled','reconciliation_required')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  application_fee_refund_minor bigint NOT NULL DEFAULT 0 CHECK (application_fee_refund_minor >= 0),
  allocation jsonb NOT NULL,
  reason_code text NOT NULL,
  idempotency_key text NOT NULL,
  provider_refund_id text,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE NULLS NOT DISTINCT (tenant_id, payment_attempt_id, provider_refund_id),
  CHECK (application_fee_refund_minor <= amount_minor),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_attempt_id) REFERENCES payment_attempts(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE disputes (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL,
  provider_dispute_id text NOT NULL,
  state text NOT NULL
    CHECK (state IN ('warning','needs_response','under_review','won','lost','closed')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  reason text,
  due_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_dispute_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_attempt_id) REFERENCES payment_attempts(tenant_id, id)
);

CREATE TABLE platform_fees (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL,
  eligible_base_minor bigint NOT NULL CHECK (eligible_base_minor >= 0),
  pricing_plan_code text NOT NULL
    CHECK (pricing_plan_code IN ('dock','growth','fleet','enterprise')),
  pricing_schedule_version text NOT NULL
    CHECK (length(pricing_schedule_version) BETWEEN 1 AND 80),
  rate_basis_points integer NOT NULL CHECK (rate_basis_points BETWEEN 75 AND 300),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  refunded_fee_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_fee_minor >= 0),
  provider_application_fee_id text,
  state text NOT NULL DEFAULT 'expected'
    CHECK (state IN ('expected','collected','partially_refunded','refunded','exception')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, payment_attempt_id),
  CHECK (refunded_fee_minor <= fee_minor),
  CHECK (fee_minor = ((eligible_base_minor * rate_basis_points + 5000) / 10000)),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_attempt_id) REFERENCES payment_attempts(tenant_id, id)
);

CREATE TABLE payout_reconciliation (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_account_id uuid NOT NULL,
  provider_payout_id text NOT NULL,
  currency char(3) NOT NULL,
  expected_minor bigint NOT NULL,
  actual_minor bigint,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','matched','exception','paid','failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_account_id, provider_payout_id),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES provider_accounts(tenant_id, id)
);

CREATE TABLE packages (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid,
  name text NOT NULL,
  unit_code text NOT NULL,
  original_units numeric(12,3) NOT NULL CHECK (original_units > 0),
  rules jsonb NOT NULL,
  validity_days integer CHECK (validity_days > 0),
  transferable boolean NOT NULL DEFAULT false,
  shared boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE package_accounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL,
  owner_customer_id uuid,
  ownership_type text NOT NULL
    CHECK (ownership_type IN ('named','family','shared','corporate')),
  unit_code text NOT NULL,
  available_balance numeric(12,3) NOT NULL CHECK (available_balance >= 0),
  expires_on date,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','expired','suspended','closed')),
  secure_code_hash bytea NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, secure_code_hash),
  FOREIGN KEY (tenant_id, package_id) REFERENCES packages(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE package_ledger_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  entry_type text NOT NULL
    CHECK (entry_type IN ('purchase','redemption_hold','redemption','hold_release','cancellation_reinstatement','expiration','manual_credit','manual_debit','refund','transfer')),
  delta numeric(12,3) NOT NULL,
  balance_after numeric(12,3) NOT NULL CHECK (balance_after >= 0),
  command_id uuid NOT NULL,
  booking_id uuid,
  order_id uuid,
  original_entry_id uuid,
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES package_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, original_entry_id) REFERENCES package_ledger_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE UNIQUE INDEX package_redemption_once_idx
  ON package_ledger_entries (tenant_id, original_entry_id)
  WHERE entry_type = 'redemption';

CREATE TABLE credit_accounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_customer_id uuid,
  account_type text NOT NULL
    CHECK (account_type IN ('gift_card','promotional','refund_credit','service_credit')),
  currency char(3) NOT NULL,
  available_minor bigint NOT NULL CHECK (available_minor >= 0),
  expires_on date,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','expired','suspended','closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE gift_cards (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  credit_account_id uuid NOT NULL,
  secure_code_hash bytea NOT NULL,
  purchaser_customer_id uuid,
  recipient_ciphertext bytea,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','expired','closed')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, secure_code_hash),
  FOREIGN KEY (tenant_id, credit_account_id) REFERENCES credit_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, purchaser_customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE credit_ledger_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  entry_type text NOT NULL
    CHECK (entry_type IN ('purchase','hold','redemption','release','refund','expiration','manual_credit','manual_debit','transfer')),
  delta_minor bigint NOT NULL,
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  command_id uuid NOT NULL,
  booking_id uuid,
  order_id uuid,
  original_entry_id uuid,
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES credit_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, original_entry_id) REFERENCES credit_ledger_entries(tenant_id, id)
);

CREATE UNIQUE INDEX credit_redemption_once_idx
  ON credit_ledger_entries (tenant_id, original_entry_id)
  WHERE entry_type = 'redemption';

COMMIT;

BEGIN;

CREATE TABLE disruptions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','watching','decision_required','approved','executing','partially_resolved','resolved','cancelled')),
  reason_code text NOT NULL,
  summary text NOT NULL,
  weather_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision jsonb,
  approved_by uuid,
  approved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE disruption_departures (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  disruption_id uuid NOT NULL,
  departure_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, disruption_id, departure_id),
  FOREIGN KEY (tenant_id, disruption_id) REFERENCES disruptions(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id)
);

CREATE TABLE disruption_actions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  disruption_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('departure','booking','participant','crew')),
  target_id uuid NOT NULL,
  action_type text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','succeeded','failed','manual_review','cancelled')),
  idempotency_key text NOT NULL,
  result jsonb,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, disruption_id) REFERENCES disruptions(tenant_id, id)
);

CREATE TABLE waitlist_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  product_id uuid,
  location_id uuid,
  party_size integer NOT NULL CHECK (party_size > 0),
  earliest_date date,
  latest_date date,
  partial_party_allowed boolean NOT NULL DEFAULT false,
  priority_class text NOT NULL DEFAULT 'first_come'
    CHECK (priority_class IN ('package','membership','first_come','operator')),
  priority_score integer NOT NULL DEFAULT 0,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting','offered','booked','expired','cancelled','opted_out')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK (latest_date IS NULL OR earliest_date IS NULL OR latest_date >= earliest_date),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

CREATE TABLE waitlist_offers (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL,
  capacity_hold_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','delivered','accepted','expired','failed','cancelled')),
  offered_party_size integer NOT NULL CHECK (offered_party_size > 0),
  expires_at timestamptz NOT NULL,
  claim_token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, capacity_hold_id),
  UNIQUE (tenant_id, claim_token_hash),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES waitlist_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, capacity_hold_id) REFERENCES capacity_holds(tenant_id, id)
);

CREATE TABLE charter_inquiries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  location_id uuid,
  requested_date date,
  alternate_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  passenger_count integer CHECK (passenger_count > 0),
  itinerary text,
  state text NOT NULL DEFAULT 'new'
    CHECK (state IN ('new','qualifying','quoted','accepted','declined','expired','converted')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

CREATE TABLE charter_proposals (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  resource_reservation_id uuid,
  proposal jsonb NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  converted_booking_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, inquiry_id, version_number),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES charter_inquiries(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_reservation_id) REFERENCES resource_reservations(tenant_id, id),
  FOREIGN KEY (tenant_id, converted_booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE message_templates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  location_id uuid,
  product_id uuid,
  journey_code text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  locale text NOT NULL DEFAULT 'en-US',
  version_number integer NOT NULL CHECK (version_number > 0),
  subject_template text,
  body_template text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, location_id, product_id, journey_code, channel, locale, version_number),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE messages (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid,
  booking_id uuid,
  departure_id uuid,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  direction text NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound','inbound')),
  recipient_ciphertext bytea NOT NULL,
  sender text,
  subject text,
  body_ciphertext bytea NOT NULL,
  locale text NOT NULL DEFAULT 'en-US',
  consent_record_id uuid,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','sending','sent','delivered','failed','received','suppressed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id)
);

CREATE TABLE message_deliveries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL,
  provider text NOT NULL,
  provider_message_id text,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  provider_status text,
  state text NOT NULL
    CHECK (state IN ('submitted','accepted','sent','delivered','undelivered','failed','received')),
  error_code text,
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_id, attempt_number),
  UNIQUE NULLS NOT DISTINCT (provider, provider_message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
);

CREATE TABLE consent_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  participant_id uuid,
  channel text NOT NULL CHECK (channel IN ('sms','email','phone','push')),
  subject text NOT NULL CHECK (subject IN ('transactional','marketing')),
  sender_scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('opted_in','opted_out')),
  source text NOT NULL,
  policy_version text NOT NULL,
  evidence jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((customer_id IS NOT NULL) <> (participant_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES consent_records(tenant_id, id)
);

ALTER TABLE messages
  ADD FOREIGN KEY (tenant_id, consent_record_id)
  REFERENCES consent_records(tenant_id, id);

CREATE TABLE webhook_inbox (
  tenant_id uuid REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','production')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  signature_valid boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  raw_payload jsonb NOT NULL,
  signature_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_state text NOT NULL DEFAULT 'pending'
    CHECK (processing_state IN ('pending','processing','processed','failed','quarantined','ignored')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  processed_at timestamptz,
  related_type text,
  related_id uuid,
  PRIMARY KEY (id),
  UNIQUE (provider, environment, provider_event_id)
);

CREATE INDEX webhook_inbox_pending_idx
  ON webhook_inbox (received_at)
  WHERE processing_state IN ('pending','failed');

CREATE TABLE transactional_outbox (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  available_after timestamptz NOT NULL DEFAULT transaction_timestamp(),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','publishing','published','failed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type)
);

CREATE INDEX transactional_outbox_publish_idx
  ON transactional_outbox (available_after, occurred_at)
  WHERE state IN ('pending','failed');

CREATE TABLE event_consumptions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  result_hash bytea,
  PRIMARY KEY (tenant_id, consumer_name, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES transactional_outbox(tenant_id, id)
);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  state text NOT NULL DEFAULT 'processing'
    CHECK (state IN ('processing','completed','failed')),
  response_status integer,
  response_body jsonb,
  locked_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, scope, idempotency_key)
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','service','device','support')),
  actor_id uuid,
  support_session_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  reason_code text,
  correlation_id uuid NOT NULL,
  source_ip_ciphertext bytea,
  device_id uuid,
  before_hash bytea,
  after_hash bytea,
  redacted_diff jsonb,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX audit_events_target_idx
  ON audit_events (tenant_id, target_type, target_id, occurred_at DESC);

CREATE TABLE offline_devices (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  public_key bytea NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  app_version text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending','active','revoked','expired','lost')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  local_data_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE offline_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  device_id uuid NOT NULL,
  local_sequence bigint NOT NULL CHECK (local_sequence > 0),
  command_type text NOT NULL,
  payload_version integer NOT NULL CHECK (payload_version > 0),
  payload jsonb NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  base_version integer,
  occurred_at_local timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  server_sequence bigint GENERATED ALWAYS AS IDENTITY,
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','applied','noop','conflict','rejected','failed')),
  result jsonb,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, device_id, local_sequence),
  UNIQUE (tenant_id, server_sequence),
  FOREIGN KEY (tenant_id, device_id) REFERENCES offline_devices(tenant_id, id)
);

CREATE TABLE sync_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid NOT NULL,
  stream_name text NOT NULL,
  server_sequence bigint NOT NULL DEFAULT 0 CHECK (server_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, device_id, stream_name),
  FOREIGN KEY (tenant_id, device_id) REFERENCES offline_devices(tenant_id, id)
);

CREATE TABLE sync_conflicts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  offline_command_id uuid NOT NULL,
  conflict_type text NOT NULL,
  server_state jsonb NOT NULL,
  device_intent jsonb NOT NULL,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','resolved_server','resolved_device','resolved_manual','dismissed')),
  resolution jsonb,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, offline_command_id),
  FOREIGN KEY (tenant_id, offline_command_id) REFERENCES offline_commands(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE external_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','production')),
  external_account_id text NOT NULL DEFAULT '',
  object_type text NOT NULL,
  external_id text NOT NULL,
  internal_type text NOT NULL,
  internal_id uuid NOT NULL,
  import_version text,
  raw_reference text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, environment, external_account_id, object_type, external_id)
);

CREATE TABLE outgoing_webhook_subscriptions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_url text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','disabled')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE outgoing_webhook_deliveries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  event_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','delivered','failed','dead_letter')),
  response_status integer,
  response_body_truncated text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, subscription_id, event_id, attempt_number),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES outgoing_webhook_subscriptions(tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES transactional_outbox(tenant_id, id)
);

CREATE TABLE reconciliation_exceptions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  exception_type text NOT NULL,
  related_type text NOT NULL,
  related_id uuid,
  severity text NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','investigating','resolved','accepted')),
  details jsonb NOT NULL,
  assigned_to uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES users(tenant_id, id)
);

COMMIT;

BEGIN;

CREATE TABLE document_objects (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  object_key text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  classification text NOT NULL
    CHECK (classification IN ('internal','personal','sensitive','medical','minor','incident')),
  encryption_key_version integer,
  malware_status text NOT NULL DEFAULT 'pending'
    CHECK (malware_status IN ('pending','clean','quarantined','failed')),
  retention_until date,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, object_key)
);

CREATE TABLE waiver_templates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  activity_code text,
  jurisdiction text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE waiver_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  effective_during daterange NOT NULL,
  document_object_id uuid NOT NULL,
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  consent_text text NOT NULL,
  requires_resign boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, template_id, version_number),
  FOREIGN KEY (tenant_id, template_id) REFERENCES waiver_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, document_object_id) REFERENCES document_objects(tenant_id, id)
);

CREATE TABLE waiver_signatures (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  waiver_version_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  guardian_id uuid,
  signer_name_ciphertext bytea NOT NULL,
  signed_at timestamptz NOT NULL,
  ip_ciphertext bytea,
  device_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_evidence jsonb NOT NULL,
  signed_document_object_id uuid NOT NULL,
  signed_hash bytea NOT NULL CHECK (octet_length(signed_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, waiver_version_id) REFERENCES waiver_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id),
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians(tenant_id, id),
  FOREIGN KEY (tenant_id, signed_document_object_id) REFERENCES document_objects(tenant_id, id)
);

CREATE TABLE medical_forms (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL,
  product_id uuid,
  form_version text NOT NULL,
  answers_ciphertext bytea NOT NULL,
  key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','review_required','accepted','rejected','expired','superseded')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  physician_document_id uuid,
  expires_on date,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, physician_document_id) REFERENCES document_objects(tenant_id, id)
);

CREATE TABLE certification_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL,
  certification_type text NOT NULL,
  agency text,
  certification_number_ciphertext bytea,
  issued_on date,
  expires_on date,
  document_object_id uuid,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','rejected','expired','superseded')),
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES participants(tenant_id, id),
  FOREIGN KEY (tenant_id, document_object_id) REFERENCES document_objects(tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE vessels (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text NOT NULL,
  registration_ciphertext bytea,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','restricted','out_of_service','retired')),
  route_restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_crew jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, resource_id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

ALTER TABLE capacity_profiles
  ADD FOREIGN KEY (tenant_id, vessel_id)
  REFERENCES vessels(tenant_id, id);

CREATE TABLE vessel_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL,
  document_type text NOT NULL,
  document_object_id uuid NOT NULL,
  issued_on date,
  expires_on date,
  restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','expired','superseded')),
  verified_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, vessel_id) REFERENCES vessels(tenant_id, id),
  FOREIGN KEY (tenant_id, document_object_id) REFERENCES document_objects(tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE maintenance_blocks (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL,
  resource_reservation_id uuid NOT NULL,
  block_type text NOT NULL
    CHECK (block_type IN ('maintenance','defect','inspection','cleaning','fueling','out_of_service')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','awaiting_approval','closed','cancelled')),
  reason text NOT NULL,
  return_to_service_by uuid,
  return_to_service_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, resource_reservation_id),
  FOREIGN KEY (tenant_id, vessel_id) REFERENCES vessels(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_reservation_id) REFERENCES resource_reservations(tenant_id, id),
  FOREIGN KEY (tenant_id, return_to_service_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE crew_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL,
  user_id uuid,
  home_location_id uuid,
  given_name_ciphertext bytea NOT NULL,
  family_name_ciphertext bytea NOT NULL,
  worker_classification text
    CHECK (worker_classification IN ('employee','contractor','volunteer','unknown')),
  payroll_metadata_ciphertext bytea,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','suspended')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, resource_id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, home_location_id) REFERENCES locations(tenant_id, id)
);

CREATE TABLE crew_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  crew_member_id uuid NOT NULL,
  credential_code text NOT NULL,
  credential_number_ciphertext bytea,
  restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_on date,
  expires_on date,
  document_object_id uuid,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','rejected','expired','superseded')),
  verified_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, crew_member_id) REFERENCES crew_members(tenant_id, id),
  FOREIGN KEY (tenant_id, document_object_id) REFERENCES document_objects(tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by) REFERENCES users(tenant_id, id)
);

CREATE INDEX crew_credentials_valid_idx
  ON crew_credentials (tenant_id, crew_member_id, credential_code, expires_on)
  WHERE status = 'verified';

CREATE TABLE crew_availability (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  crew_member_id uuid NOT NULL,
  availability_type text NOT NULL
    CHECK (availability_type IN ('available','unavailable','training','leave')),
  occupied_range tstzrange NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK (NOT isempty(occupied_range)),
  FOREIGN KEY (tenant_id, crew_member_id) REFERENCES crew_members(tenant_id, id)
);

CREATE TABLE crew_assignments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL,
  crew_member_id uuid NOT NULL,
  resource_reservation_id uuid NOT NULL,
  role_code text NOT NULL,
  required_credential_code text,
  state text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','confirmed','checked_in','completed','cancelled','replaced','exception')),
  override_reason_code text,
  override_note text,
  planned_minutes integer CHECK (planned_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, departure_id, crew_member_id, role_code),
  UNIQUE (tenant_id, resource_reservation_id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, crew_member_id) REFERENCES crew_members(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_reservation_id) REFERENCES resource_reservations(tenant_id, id),
  CHECK ((state <> 'exception') OR override_reason_code IS NOT NULL)
);

CREATE TABLE crew_time_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  crew_assignment_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  source text NOT NULL CHECK (source IN ('planned','clock','manager','import')),
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  FOREIGN KEY (tenant_id, crew_assignment_id) REFERENCES crew_assignments(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE tip_allocations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  departure_id uuid NOT NULL,
  crew_assignment_id uuid NOT NULL,
  allocation_method text NOT NULL
    CHECK (allocation_method IN ('fixed_percentage','role','hours','equal','manager_override','adjustment')),
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  command_id uuid NOT NULL,
  original_allocation_id uuid,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, crew_assignment_id) REFERENCES crew_assignments(tenant_id, id),
  FOREIGN KEY (tenant_id, original_allocation_id) REFERENCES tip_allocations(tenant_id, id)
);

CREATE TABLE equipment_pools (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL,
  equipment_type text NOT NULL,
  size_code text,
  total_quantity numeric(12,3) NOT NULL CHECK (total_quantity >= 0),
  held_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (held_quantity >= 0),
  allocated_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (allocated_quantity >= 0),
  cleaning_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (cleaning_quantity >= 0),
  maintenance_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (maintenance_quantity >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, location_id, equipment_type, size_code),
  CHECK (held_quantity + allocated_quantity + cleaning_quantity + maintenance_quantity <= total_quantity),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations(tenant_id, id)
);

CREATE TABLE equipment_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  pool_id uuid,
  resource_id uuid,
  serial_number_ciphertext bytea,
  condition_code text NOT NULL DEFAULT 'serviceable',
  inspection_due_on date,
  maintenance_status text NOT NULL DEFAULT 'available'
    CHECK (maintenance_status IN ('available','cleaning','maintenance','out_of_service','lost','retired')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, resource_id),
  FOREIGN KEY (tenant_id, pool_id) REFERENCES equipment_pools(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id),
  CHECK (resource_id IS NOT NULL OR pool_id IS NOT NULL)
);

CREATE TABLE equipment_holds (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  checkout_session_id uuid NOT NULL,
  pool_id uuid,
  item_id uuid,
  resource_reservation_id uuid,
  quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held','allocated','released','expired','cancelled')),
  occupied_range tstzrange NOT NULL,
  expires_at timestamptz NOT NULL,
  command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, command_id),
  CHECK ((pool_id IS NOT NULL) <> (item_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES checkout_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, pool_id) REFERENCES equipment_pools(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES equipment_items(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_reservation_id) REFERENCES resource_reservations(tenant_id, id)
);

CREATE TABLE equipment_allocations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  equipment_hold_id uuid,
  booking_id uuid NOT NULL,
  booking_participant_id uuid,
  departure_id uuid NOT NULL,
  pool_id uuid,
  item_id uuid,
  quantity numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  occupied_range tstzrange NOT NULL,
  state text NOT NULL DEFAULT 'allocated'
    CHECK (state IN ('allocated','checked_out','returned','cleaning','maintenance','damaged','lost','released','cancelled')),
  condition_out text,
  condition_in text,
  checked_out_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((pool_id IS NOT NULL) <> (item_id IS NOT NULL)),
  CHECK (NOT isempty(occupied_range)),
  CHECK (lower_inc(occupied_range) AND NOT upper_inc(occupied_range)),
  CHECK (item_id IS NULL OR equipment_hold_id IS NOT NULL),
  FOREIGN KEY (tenant_id, equipment_hold_id) REFERENCES equipment_holds(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_participant_id) REFERENCES booking_participants(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, pool_id) REFERENCES equipment_pools(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES equipment_items(tenant_id, id)
);

ALTER TABLE equipment_allocations
  ADD CONSTRAINT equipment_item_no_active_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    item_id WITH =,
    occupied_range WITH &&
  )
  WHERE (
    item_id IS NOT NULL
    AND state IN ('allocated','checked_out','cleaning','maintenance','damaged')
  );

CREATE TABLE manifests (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','boarding','departed','returned','closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, departure_id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id)
);

CREATE TABLE manifest_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  manifest_id uuid NOT NULL,
  departure_id uuid NOT NULL,
  snapshot_number integer NOT NULL DEFAULT 1 CHECK (snapshot_number > 0),
  snapshot jsonb NOT NULL,
  snapshot_hash bytea NOT NULL CHECK (octet_length(snapshot_hash) = 32),
  document_object_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, manifest_id, snapshot_number),
  FOREIGN KEY (tenant_id, manifest_id) REFERENCES manifests(tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, document_object_id) REFERENCES document_objects(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE checklists (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL,
  vessel_id uuid,
  checklist_type text NOT NULL
    CHECK (checklist_type IN ('pre_departure','safety','briefing','post_trip','maintenance','custom')),
  template_version text NOT NULL,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','in_progress','complete','failed','waived')),
  items jsonb NOT NULL,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, vessel_id) REFERENCES vessels(tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE incidents (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL,
  manifest_snapshot_id uuid,
  incident_type text NOT NULL
    CHECK (incident_type IN ('near_miss','injury','first_aid','customer_issue','equipment_damage','equipment_loss','operational','other')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','under_review','action_required','closed')),
  occurred_at timestamptz NOT NULL,
  chronology jsonb NOT NULL,
  sensitive_details_ciphertext bytea,
  key_version integer,
  created_by uuid NOT NULL,
  reviewed_by uuid,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, departure_id) REFERENCES departure_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, manifest_snapshot_id) REFERENCES manifest_snapshots(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE incident_attachments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  incident_id uuid NOT NULL,
  document_object_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, incident_id, document_object_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id),
  FOREIGN KEY (tenant_id, document_object_id) REFERENCES document_objects(tenant_id, id)
);

COMMIT;

BEGIN;

ALTER TABLE equipment_holds
  ADD CONSTRAINT equipment_item_hold_requires_reservation
  CHECK (item_id IS NULL OR resource_reservation_id IS NOT NULL);

ALTER TABLE equipment_holds
  ADD CONSTRAINT equipment_item_hold_no_active_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    item_id WITH =,
    occupied_range WITH &&
  )
  WHERE (
    item_id IS NOT NULL
    AND status IN ('held','allocated')
  );

CREATE INDEX bookings_departure_state_idx
  ON bookings (tenant_id, departure_id, lifecycle_state, readiness_state);
CREATE INDEX booking_participants_manifest_idx
  ON booking_participants (tenant_id, booking_id, state);
CREATE INDEX capacity_holds_expiry_idx
  ON capacity_holds (expires_at)
  WHERE status = 'held';
CREATE INDEX equipment_holds_expiry_idx
  ON equipment_holds (expires_at)
  WHERE status = 'held';
CREATE INDEX message_deliveries_provider_idx
  ON message_deliveries (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX offline_commands_processing_idx
  ON offline_commands (tenant_id, state, server_sequence)
  WHERE state IN ('received','failed');
CREATE INDEX outgoing_webhook_retry_idx
  ON outgoing_webhook_deliveries (next_attempt_at)
  WHERE state IN ('pending','failed');

-- Capacity mutation functions lock the projection row and write the hold in the
-- same transaction. Callers retry serialization failures with bounded jitter.
CREATE OR REPLACE FUNCTION app.acquire_capacity_hold(
  p_tenant_id uuid,
  p_bucket_id uuid,
  p_checkout_session_id uuid,
  p_quantity numeric,
  p_expires_at timestamptz,
  p_command_id uuid
)
RETURNS capacity_holds
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_hold capacity_holds%ROWTYPE;
BEGIN
  SELECT * INTO v_hold
    FROM capacity_holds
   WHERE tenant_id = p_tenant_id AND command_id = p_command_id;
  IF FOUND THEN
    RETURN v_hold;
  END IF;

  IF p_quantity <= 0 OR p_expires_at <= transaction_timestamp() THEN
    RAISE EXCEPTION 'invalid capacity hold request' USING ERRCODE = '22023';
  END IF;

  UPDATE capacity_buckets
     SET held_quantity = held_quantity + p_quantity,
         version = version + 1,
         updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id
     AND id = p_bucket_id
     AND held_quantity + confirmed_quantity + p_quantity <= limit_quantity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capacity unavailable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO capacity_holds (
    tenant_id, bucket_id, checkout_session_id, quantity,
    status, expires_at, command_id
  ) VALUES (
    p_tenant_id, p_bucket_id, p_checkout_session_id, p_quantity,
    'held', p_expires_at, p_command_id
  ) RETURNING * INTO v_hold;

  RETURN v_hold;
END;
$$;

CREATE OR REPLACE FUNCTION app.confirm_capacity_hold(
  p_tenant_id uuid,
  p_hold_id uuid,
  p_booking_id uuid
)
RETURNS capacity_holds
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_hold capacity_holds%ROWTYPE;
BEGIN
  SELECT * INTO v_hold
    FROM capacity_holds
   WHERE tenant_id = p_tenant_id AND id = p_hold_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capacity hold not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_hold.status = 'confirmed' AND v_hold.booking_id = p_booking_id THEN
    RETURN v_hold;
  END IF;
  IF v_hold.status <> 'held' OR v_hold.expires_at <= transaction_timestamp() THEN
    RAISE EXCEPTION 'capacity hold is not confirmable' USING ERRCODE = 'P0001';
  END IF;

  UPDATE capacity_buckets
     SET held_quantity = held_quantity - v_hold.quantity,
         confirmed_quantity = confirmed_quantity + v_hold.quantity,
         version = version + 1,
         updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id AND id = v_hold.bucket_id;

  UPDATE capacity_holds
     SET status = 'confirmed', booking_id = p_booking_id,
         updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id AND id = p_hold_id
  RETURNING * INTO v_hold;
  RETURN v_hold;
END;
$$;

CREATE OR REPLACE FUNCTION app.release_capacity_hold(
  p_tenant_id uuid,
  p_hold_id uuid,
  p_target_status text DEFAULT 'released'
)
RETURNS capacity_holds
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_hold capacity_holds%ROWTYPE;
BEGIN
  IF p_target_status NOT IN ('released','expired','cancelled') THEN
    RAISE EXCEPTION 'invalid release status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_hold
    FROM capacity_holds
   WHERE tenant_id = p_tenant_id AND id = p_hold_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capacity hold not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_hold.status IN ('released','expired','cancelled') THEN
    RETURN v_hold;
  END IF;

  IF v_hold.status = 'held' THEN
    UPDATE capacity_buckets
       SET held_quantity = held_quantity - v_hold.quantity,
           version = version + 1,
           updated_at = transaction_timestamp()
     WHERE tenant_id = p_tenant_id AND id = v_hold.bucket_id;
  ELSIF v_hold.status = 'confirmed' THEN
    UPDATE capacity_buckets
       SET confirmed_quantity = confirmed_quantity - v_hold.quantity,
           version = version + 1,
           updated_at = transaction_timestamp()
     WHERE tenant_id = p_tenant_id AND id = v_hold.bucket_id;
  END IF;

  UPDATE capacity_holds
     SET status = p_target_status, updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id AND id = p_hold_id
  RETURNING * INTO v_hold;
  RETURN v_hold;
END;
$$;

-- Stored-value projections are derived under a locked account row. Ledger rows
-- remain immutable and every command is deduplicated by command_id.
CREATE OR REPLACE FUNCTION app.append_package_entry(
  p_tenant_id uuid,
  p_account_id uuid,
  p_entry_type text,
  p_delta numeric,
  p_command_id uuid,
  p_booking_id uuid DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_original_entry_id uuid DEFAULT NULL,
  p_reason_code text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS package_ledger_entries
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_account package_accounts%ROWTYPE;
  v_entry package_ledger_entries%ROWTYPE;
  v_balance numeric(12,3);
BEGIN
  SELECT * INTO v_entry
    FROM package_ledger_entries
   WHERE tenant_id = p_tenant_id AND command_id = p_command_id;
  IF FOUND THEN
    RETURN v_entry;
  END IF;

  SELECT * INTO v_account
    FROM package_accounts
   WHERE tenant_id = p_tenant_id AND id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'package account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_account.state <> 'active'
     OR (v_account.expires_on IS NOT NULL AND v_account.expires_on < CURRENT_DATE) THEN
    RAISE EXCEPTION 'package account is not active' USING ERRCODE = 'P0001';
  END IF;

  v_balance := v_account.available_balance + p_delta;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'insufficient package balance' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO package_ledger_entries (
    tenant_id, account_id, entry_type, delta, balance_after, command_id,
    booking_id, order_id, original_entry_id, reason_code, created_by
  ) VALUES (
    p_tenant_id, p_account_id, p_entry_type, p_delta, v_balance, p_command_id,
    p_booking_id, p_order_id, p_original_entry_id, p_reason_code, p_created_by
  ) RETURNING * INTO v_entry;

  UPDATE package_accounts
     SET available_balance = v_balance, version = version + 1,
         updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id AND id = p_account_id;
  RETURN v_entry;
END;
$$;

CREATE OR REPLACE FUNCTION app.append_credit_entry(
  p_tenant_id uuid,
  p_account_id uuid,
  p_entry_type text,
  p_delta_minor bigint,
  p_command_id uuid,
  p_booking_id uuid DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_original_entry_id uuid DEFAULT NULL,
  p_reason_code text DEFAULT NULL
)
RETURNS credit_ledger_entries
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_account credit_accounts%ROWTYPE;
  v_entry credit_ledger_entries%ROWTYPE;
  v_balance bigint;
BEGIN
  SELECT * INTO v_entry
    FROM credit_ledger_entries
   WHERE tenant_id = p_tenant_id AND command_id = p_command_id;
  IF FOUND THEN
    RETURN v_entry;
  END IF;

  SELECT * INTO v_account
    FROM credit_accounts
   WHERE tenant_id = p_tenant_id AND id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_account.state <> 'active'
     OR (v_account.expires_on IS NOT NULL AND v_account.expires_on < CURRENT_DATE) THEN
    RAISE EXCEPTION 'credit account is not active' USING ERRCODE = 'P0001';
  END IF;

  v_balance := v_account.available_minor + p_delta_minor;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'insufficient credit balance' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO credit_ledger_entries (
    tenant_id, account_id, entry_type, delta_minor, balance_after_minor,
    command_id, booking_id, order_id, original_entry_id, reason_code
  ) VALUES (
    p_tenant_id, p_account_id, p_entry_type, p_delta_minor, v_balance,
    p_command_id, p_booking_id, p_order_id, p_original_entry_id, p_reason_code
  ) RETURNING * INTO v_entry;

  UPDATE credit_accounts
     SET available_minor = v_balance, version = version + 1,
         updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id AND id = p_account_id;
  RETURN v_entry;
END;
$$;

CREATE OR REPLACE FUNCTION app.acquire_pooled_equipment_hold(
  p_tenant_id uuid,
  p_checkout_session_id uuid,
  p_pool_id uuid,
  p_quantity numeric,
  p_occupied_range tstzrange,
  p_expires_at timestamptz,
  p_command_id uuid
)
RETURNS equipment_holds
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_hold equipment_holds%ROWTYPE;
BEGIN
  SELECT * INTO v_hold
    FROM equipment_holds
   WHERE tenant_id = p_tenant_id AND command_id = p_command_id;
  IF FOUND THEN
    RETURN v_hold;
  END IF;
  IF p_quantity <= 0 OR isempty(p_occupied_range)
     OR p_expires_at <= transaction_timestamp() THEN
    RAISE EXCEPTION 'invalid equipment hold request' USING ERRCODE = '22023';
  END IF;

  UPDATE equipment_pools
     SET held_quantity = held_quantity + p_quantity,
         version = version + 1,
         updated_at = transaction_timestamp()
   WHERE tenant_id = p_tenant_id
     AND id = p_pool_id
     AND held_quantity + allocated_quantity + cleaning_quantity
         + maintenance_quantity + p_quantity <= total_quantity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'equipment unavailable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO equipment_holds (
    tenant_id, checkout_session_id, pool_id, quantity, status,
    occupied_range, expires_at, command_id
  ) VALUES (
    p_tenant_id, p_checkout_session_id, p_pool_id, p_quantity, 'held',
    p_occupied_range, p_expires_at, p_command_id
  ) RETURNING * INTO v_hold;
  RETURN v_hold;
END;
$$;

CREATE OR REPLACE FUNCTION app.validate_resource_qualification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_local_date date;
BEGIN
  IF NEW.qualification_code IS NULL
     OR NEW.status NOT IN ('held','confirmed','blocked')
     OR NEW.departure_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT local_date INTO v_local_date
    FROM departure_instances
   WHERE tenant_id = NEW.tenant_id AND id = NEW.departure_id;
  IF NOT EXISTS (
    SELECT 1
      FROM resource_qualifications q
     WHERE q.tenant_id = NEW.tenant_id
       AND q.resource_id = NEW.resource_id
       AND q.qualification_code = NEW.qualification_code
       AND q.verification_status = 'verified'
       AND q.valid_during @> v_local_date
  ) THEN
    RAISE EXCEPTION 'resource lacks active verified qualification %', NEW.qualification_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER resource_reservation_qualification_guard
AFTER INSERT OR UPDATE OF resource_id, departure_id, qualification_code, status
ON resource_reservations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION app.validate_resource_qualification();

CREATE OR REPLACE FUNCTION app.validate_crew_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  v_resource_id uuid;
  v_local_date date;
  v_reserved_resource_id uuid;
  v_reserved_departure_id uuid;
  v_reservation_status text;
BEGIN
  SELECT cm.resource_id, di.local_date
    INTO v_resource_id, v_local_date
    FROM crew_members cm
    JOIN departure_instances di
      ON di.tenant_id = cm.tenant_id AND di.id = NEW.departure_id
   WHERE cm.tenant_id = NEW.tenant_id AND cm.id = NEW.crew_member_id;

  SELECT resource_id, departure_id, status
    INTO v_reserved_resource_id, v_reserved_departure_id, v_reservation_status
    FROM resource_reservations
   WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_reservation_id;

  IF v_resource_id IS NULL
     OR v_reserved_resource_id IS DISTINCT FROM v_resource_id
     OR v_reserved_departure_id IS DISTINCT FROM NEW.departure_id
     OR v_reservation_status NOT IN ('held','confirmed') THEN
    RAISE EXCEPTION 'crew assignment and resource reservation do not match'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.required_credential_code IS NOT NULL AND NEW.state <> 'exception'
     AND NOT EXISTS (
       SELECT 1
         FROM crew_credentials c
        WHERE c.tenant_id = NEW.tenant_id
          AND c.crew_member_id = NEW.crew_member_id
          AND c.credential_code = NEW.required_credential_code
          AND c.status = 'verified'
          AND (c.issued_on IS NULL OR c.issued_on <= v_local_date)
          AND (c.expires_on IS NULL OR c.expires_on >= v_local_date)
     ) THEN
    RAISE EXCEPTION 'crew member lacks active verified credential %', NEW.required_credential_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER crew_assignment_guard
AFTER INSERT OR UPDATE OF departure_id, crew_member_id,
  resource_reservation_id, required_credential_code, state
ON crew_assignments
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION app.validate_crew_assignment();

-- Evidence and financial history are append-only. Corrections are new rows that
-- reference the original entry.
CREATE TRIGGER package_ledger_append_only
BEFORE UPDATE OR DELETE ON package_ledger_entries
FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER credit_ledger_append_only
BEFORE UPDATE OR DELETE ON credit_ledger_entries
FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_signatures_append_only
BEFORE UPDATE OR DELETE ON waiver_signatures
FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER manifest_snapshots_append_only
BEFORE UPDATE OR DELETE ON manifest_snapshots
FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER tip_allocations_append_only
BEFORE UPDATE OR DELETE ON tip_allocations
FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Keep operational timestamps database-generated, including bulk and offline
-- command paths that do not pass through an ORM hook.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND a.attname = 'updated_at'
       AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      r.nspname, r.relname
    );
  END LOOP;
END;
$$;

-- Every tenant table is protected twice: composite tenant foreign keys prevent
-- cross-tenant references and forced RLS prevents cross-tenant visibility.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.nspname, r.relname);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.nspname, r.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      r.nspname, r.relname
    );
  END LOOP;
END;
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

COMMIT;
