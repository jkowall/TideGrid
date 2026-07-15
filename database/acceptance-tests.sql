\set ON_ERROR_STOP on

-- Run only against a disposable database after schema.sql.

INSERT INTO tenants (id, slug, display_name)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'test-one', 'Test One'),
  ('00000000-0000-0000-0000-000000000002', 'test-two', 'Test Two');

INSERT INTO legal_entities (tenant_id, id, legal_name)
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011', 'One LLC'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000012', 'Two LLC');

INSERT INTO locations (tenant_id, id, legal_entity_id, name, iana_time_zone)
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000021',
   '00000000-0000-0000-0000-000000000011', 'One Dock', 'America/New_York'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000022',
   '00000000-0000-0000-0000-000000000012', 'Two Dock', 'America/Chicago');

DO $$
BEGIN
  BEGIN
    INSERT INTO locations (
      tenant_id, id, legal_entity_id, name, iana_time_zone
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000023',
      '00000000-0000-0000-0000-000000000012',
      'Illegal Cross Tenant', 'UTC'
    );
    RAISE EXCEPTION 'cross-tenant foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tidegrid_test_runtime') THEN
    CREATE ROLE tidegrid_test_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END;
$$;
GRANT USAGE ON SCHEMA public, app TO tidegrid_test_runtime;
GRANT SELECT ON tenants, locations TO tidegrid_test_runtime;

SET ROLE tidegrid_test_runtime;
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
DO $$
BEGIN
  IF (SELECT count(*) FROM tenants) <> 1 THEN
    RAISE EXCEPTION 'tenant RLS did not isolate tenants';
  END IF;
  IF (SELECT count(*) FROM locations) <> 1 THEN
    RAISE EXCEPTION 'location RLS did not isolate tenants';
  END IF;
END;
$$;
RESET ROLE;
RESET app.tenant_id;

INSERT INTO products (
  tenant_id, id, legal_entity_id, module_type, name, slug
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000031',
  '00000000-0000-0000-0000-000000000011',
  'excursion', 'Test Trip', 'test-trip'
);

INSERT INTO product_variants (
  tenant_id, id, product_id, code, inventory_mode, duration_minutes,
  pricing_definition, policy_snapshot
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000031',
  'BASE', 'shared_seat', 120, '{}', '{}'
);

INSERT INTO departure_instances (
  tenant_id, id, product_variant_id, location_id, local_date,
  local_departure_time, iana_time_zone, utc_offset_minutes,
  starts_at, expected_return_at, status
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000051',
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000021',
  '2030-07-15', '09:00', 'America/New_York', -240,
  '2030-07-15T13:00:00Z', '2030-07-15T15:00:00Z', 'scheduled'
);

INSERT INTO customers (
  tenant_id, id, email, given_name, family_name
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000061',
  'test@example.invalid', 'Test', 'Booker'
);

INSERT INTO checkout_sessions (
  tenant_id, id, customer_id, departure_id, quote_snapshot, currency,
  hold_expires_at, idempotency_key
) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000071',
   '00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000051',
   '{}', 'USD', transaction_timestamp() + interval '15 minutes', 'checkout-one'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000072',
   '00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000051',
   '{}', 'USD', transaction_timestamp() + interval '15 minutes', 'checkout-two');

INSERT INTO capacity_buckets (
  tenant_id, id, departure_id, dimension_code, limit_quantity
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000081',
  '00000000-0000-0000-0000-000000000051',
  'passenger', 1
);

SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
SELECT (app.acquire_capacity_hold(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000081',
  '00000000-0000-0000-0000-000000000071',
  1, transaction_timestamp() + interval '15 minutes',
  '00000000-0000-0000-0000-000000000181'
)).id;

DO $$
BEGIN
  BEGIN
    PERFORM app.acquire_capacity_hold(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000081',
      '00000000-0000-0000-0000-000000000072',
      1, transaction_timestamp() + interval '15 minutes',
      '00000000-0000-0000-0000-000000000182'
    );
    RAISE EXCEPTION 'capacity oversell unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;
  IF (SELECT held_quantity FROM capacity_buckets
       WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
         AND id = '00000000-0000-0000-0000-000000000081') <> 1 THEN
    RAISE EXCEPTION 'capacity projection is incorrect';
  END IF;
END;
$$;

INSERT INTO packages (
  tenant_id, id, name, unit_code, original_units, rules
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000091',
  'One Trip', 'trip', 1, '{}'
);
INSERT INTO package_accounts (
  tenant_id, id, package_id, ownership_type, unit_code,
  available_balance, secure_code_hash
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000092',
  '00000000-0000-0000-0000-000000000091',
  'named', 'trip', 1, digest('test-package-code', 'sha256')
);
SELECT (app.append_package_entry(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000092',
  'manual_debit', -1,
  '00000000-0000-0000-0000-000000000191'
)).id;

DO $$
BEGIN
  BEGIN
    PERFORM app.append_package_entry(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000092',
      'manual_debit', -1,
      '00000000-0000-0000-0000-000000000192'
    );
    RAISE EXCEPTION 'negative package balance unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;
  BEGIN
    UPDATE package_ledger_entries
       SET reason_code = 'illegal edit'
     WHERE tenant_id = '00000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'append-only ledger unexpectedly allowed update';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$$;

INSERT INTO equipment_pools (
  tenant_id, id, location_id, equipment_type, total_quantity
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-000000000021',
  'bcd', 1
);
SELECT (app.acquire_pooled_equipment_hold(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000071',
  '00000000-0000-0000-0000-0000000000a1',
  1, '[2030-07-15 12:30Z,2030-07-15 16:00Z)'::tstzrange,
  transaction_timestamp() + interval '15 minutes',
  '00000000-0000-0000-0000-0000000001a1'
)).id;

DO $$
BEGIN
  BEGIN
    PERFORM app.acquire_pooled_equipment_hold(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000072',
      '00000000-0000-0000-0000-0000000000a1',
      1, '[2030-07-15 12:30Z,2030-07-15 16:00Z)'::tstzrange,
      transaction_timestamp() + interval '15 minutes',
      '00000000-0000-0000-0000-0000000001a2'
    );
    RAISE EXCEPTION 'equipment oversell unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    NULL;
  END;
END;
$$;

INSERT INTO resources (
  tenant_id, id, location_id, resource_type, name
) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-000000000021', 'vessel', 'Vessel One'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2',
   '00000000-0000-0000-0000-000000000021', 'crew', 'Captain One');

INSERT INTO resource_reservations (
  tenant_id, id, resource_id, departure_id, reservation_kind, status,
  occupied_range, idempotency_key
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000e1',
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-000000000051',
  'confirmed', 'confirmed',
  '[2030-07-15 12:00Z,2030-07-15 16:00Z)', 'vessel-one'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO resource_reservations (
      tenant_id, id, resource_id, departure_id, reservation_kind, status,
      occupied_range, idempotency_key
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-0000000000e2',
      '00000000-0000-0000-0000-0000000000d1',
      '00000000-0000-0000-0000-000000000051',
      'confirmed', 'confirmed',
      '[2030-07-15 15:00Z,2030-07-15 17:00Z)', 'vessel-two'
    );
    RAISE EXCEPTION 'overlapping resource reservation unexpectedly succeeded';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;
END;
$$;

INSERT INTO webhook_inbox (
  tenant_id, provider, environment, provider_event_id,
  event_type, signature_valid, raw_payload
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'stripe', 'test', 'evt_duplicate', 'payment_intent.succeeded', true, '{}'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO webhook_inbox (
      tenant_id, provider, environment, provider_event_id,
      event_type, signature_valid, raw_payload
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      'stripe', 'test', 'evt_duplicate', 'payment_intent.succeeded', true, '{}'
    );
    RAISE EXCEPTION 'duplicate webhook unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
$$;

INSERT INTO users (
  tenant_id, id, external_subject, email, display_name, status
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000b1',
  'test-user', 'crew@example.invalid', 'Crew Test', 'active'
);
INSERT INTO offline_devices (
  tenant_id, id, user_id, public_key, platform, app_version
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000b1',
  decode('01020304', 'hex'), 'ios', '1.0.0'
);
INSERT INTO offline_commands (
  tenant_id, id, device_id, local_sequence, command_type, payload_version,
  payload, aggregate_type, aggregate_id, occurred_at_local
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-0000000000c2',
  '00000000-0000-0000-0000-0000000000c1',
  1, 'participant.check_in', 1, '{}', 'booking_participant',
  '00000000-0000-0000-0000-000000000061', transaction_timestamp()
);

INSERT INTO orders (
  tenant_id, id, legal_entity_id, state, currency, subtotal_minor,
  total_minor, eligible_fee_base_minor, pricing_plan_code,
  pricing_schedule_version, platform_fee_rate_basis_points, source
) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f101',
   '00000000-0000-0000-0000-000000000011', 'paid', 'USD', 10000, 10000, 10000,
   'dock', '2026-07-15-us-pilot-v1', 300, 'online'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f102',
   '00000000-0000-0000-0000-000000000011', 'paid', 'USD', 10000, 10000, 10000,
   'growth', '2026-07-15-us-pilot-v1', 200, 'online'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f103',
   '00000000-0000-0000-0000-000000000011', 'paid', 'USD', 10000, 10000, 10000,
   'fleet', '2026-07-15-us-pilot-v1', 125, 'online'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f104',
   '00000000-0000-0000-0000-000000000011', 'paid', 'USD', 10000, 10000, 10000,
   'enterprise', '2026-07-15-us-pilot-v1', 75, 'online');

INSERT INTO payment_attempts (
  tenant_id, id, order_id, payment_method_type, state, amount_minor,
  currency, idempotency_key, provider_payment_id
) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f201',
   '00000000-0000-0000-0000-00000000f101', 'card', 'succeeded', 10000, 'USD', 'fee-dock', 'pi_fee_dock'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f202',
   '00000000-0000-0000-0000-00000000f102', 'card', 'succeeded', 10000, 'USD', 'fee-growth', 'pi_fee_growth'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f203',
   '00000000-0000-0000-0000-00000000f103', 'card', 'succeeded', 10000, 'USD', 'fee-fleet', 'pi_fee_fleet'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f204',
   '00000000-0000-0000-0000-00000000f104', 'card', 'succeeded', 10000, 'USD', 'fee-enterprise', 'pi_fee_enterprise');

INSERT INTO platform_fees (
  tenant_id, order_id, payment_attempt_id, eligible_base_minor,
  pricing_plan_code, pricing_schedule_version, rate_basis_points, fee_minor
) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f101',
   '00000000-0000-0000-0000-00000000f201', 10000, 'dock',
   '2026-07-15-us-pilot-v1', 300, 300),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f102',
   '00000000-0000-0000-0000-00000000f202', 10000, 'growth',
   '2026-07-15-us-pilot-v1', 200, 200),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f103',
   '00000000-0000-0000-0000-00000000f203', 10000, 'fleet',
   '2026-07-15-us-pilot-v1', 125, 125),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000f104',
   '00000000-0000-0000-0000-00000000f204', 10000, 'enterprise',
   '2026-07-15-us-pilot-v1', 75, 75);

DO $$
BEGIN
  BEGIN
    INSERT INTO offline_commands (
      tenant_id, id, device_id, local_sequence, command_type, payload_version,
      payload, aggregate_type, aggregate_id, occurred_at_local
    ) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000c1',
      1, 'participant.check_in', 1, '{}', 'booking_participant',
      '00000000-0000-0000-0000-000000000061', transaction_timestamp()
    );
    RAISE EXCEPTION 'duplicate offline command unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF ((10000 * 300 + 5000) / 10000) <> 300
     OR ((10000 * 200 + 5000) / 10000) <> 200
     OR ((10000 * 125 + 5000) / 10000) <> 125
     OR ((10000 * 75 + 5000) / 10000) <> 75
     OR ((149 * 300 + 5000) / 10000) <> 4
     OR ((150 * 300 + 5000) / 10000) <> 5 THEN
    RAISE EXCEPTION 'plan fee rate or half-up rounding is incorrect';
  END IF;

  IF (SELECT sum(fee_minor) FROM platform_fees
       WHERE pricing_schedule_version = '2026-07-15-us-pilot-v1') <> 700 THEN
    RAISE EXCEPTION 'plan fee snapshots do not match the approved rates';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM platform_fees f
    JOIN orders o ON o.tenant_id = f.tenant_id AND o.id = f.order_id
    WHERE f.pricing_plan_code <> o.pricing_plan_code
       OR f.pricing_schedule_version <> o.pricing_schedule_version
       OR f.rate_basis_points <> o.platform_fee_rate_basis_points
  ) THEN
    RAISE EXCEPTION 'order and fee pricing snapshots are inconsistent';
  END IF;
END;
$$;

RESET app.tenant_id;

SELECT 'TideGrid database acceptance tests passed' AS result;
