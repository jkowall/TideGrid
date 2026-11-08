-- Finalization exception resolutions (W1-FIN-EXC, in the G2.12 row by the
-- owner's O-SCOPE decision of 2026-11-08)
--
-- A finalization exception is a verified payment that could not become a
-- booking (0007). The console lists them with no way out. Staff now mark one
-- as followed up, with a reason code and, when they choose, a short note.
-- A resolution records follow-up only: it changes no money, booking,
-- payment, refund, or checkout. The exception itself is never edited; the
-- open list is the exceptions with no resolution.
--
-- One resolution per exception, for ever: the second writer's insert hits
-- finalization_exception_resolutions_once, and the service answers that the
-- exception is already resolved. Append-only for every role, the owner
-- included: nobody edits or removes a resolution. Who resolved it, the
-- request, and the time come from the transaction, never from the row, as
-- booking_notes does (0008). Owners and booking staff resolve
-- (exceptions.resolve) and every role reads; the API checks the role, and
-- this table holds authorship, immutability, uniqueness, and tenancy.
--
-- The note is free text a person typed and may name a guest. It never enters
-- audit rows, outbox events, logs, or the idempotency store: the audit row
-- names the resolution's id and its reason code only. The reason code
-- 'other' requires a note.
--
-- Tenancy follows packages/database/README.md, rules 1 to 10: tenant_id on
-- every row, forced row-level security with a tenant_isolation policy, the
-- default SELECT and INSERT and nothing more, no UPDATE, DELETE, or TRUNCATE
-- for any role, and composite foreign keys that carry tenant_id, so a
-- resolution can name only its own tenant's exception and its own tenant's
-- member. No index on a pilot-volume table: the new table's own unique keys
-- are its indexes.
--
-- Applying this file. The foreign key to finalization_exceptions takes a
-- brief SHARE ROW EXCLUSIVE lock on that table, which only the payment
-- webhook and the sweep write, rarely. Apply it before the API release that
-- reads the table: that build's exception list joins it.

CREATE TABLE public.finalization_exception_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  exception_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN (
    'contacted_guest', 'refunded_outside', 'no_action_needed', 'other'
  )),
  -- The same rule as a booking note's body (0008): 1 to 500 characters, line
  -- breaks allowed, other C0 and C1 controls refused, and at least one
  -- visible character (the contract's invisibleCharacters).
  note text
    CHECK (note IS NULL
           OR (char_length(note) BETWEEN 1 AND 500
               AND note !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f]'
               AND note ~ '[^[:space:]\x01-\x1f\x7f-\x9f ­ᅟᅠ ᠎ -‏ -  -⁤⁪-⁯　ㅤ︀-️﻿ﾠ]')),
  -- The staff member who resolved it: the transaction's actor, set by the trigger.
  resolved_by_user_id uuid NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  CONSTRAINT finalization_exception_resolutions_once UNIQUE (tenant_id, exception_id),
  CONSTRAINT finalization_exception_resolutions_other_note
    CHECK (reason_code <> 'other' OR note IS NOT NULL),
  FOREIGN KEY (tenant_id, exception_id)
    REFERENCES public.finalization_exceptions (tenant_id, id),
  -- The resolver is a member of the resolution's own tenant.
  FOREIGN KEY (tenant_id, resolved_by_user_id)
    REFERENCES public.tenant_memberships (tenant_id, user_id)
);

ALTER TABLE public.finalization_exception_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finalization_exception_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.finalization_exception_resolutions
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Only a staff actor resolves, and the resolution is theirs. Runs as the
-- writer; it reads nothing but the transaction's settings.
CREATE FUNCTION app.stamp_finalization_exception_resolution() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.setting_or_null('app.actor_id');
BEGIN
  IF app.setting_or_null('app.actor_type') IS DISTINCT FROM 'staff'
     OR v_actor IS NULL
     OR v_actor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'a finalization exception is resolved by a signed-in staff member'
      USING ERRCODE = '42501', CONSTRAINT = 'finalization_exception_resolutions_staff_author';
  END IF;
  NEW.resolved_by_user_id := v_actor::uuid;
  NEW.request_id := app.setting_or_null('app.request_id');
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER finalization_exception_resolutions_stamp
  BEFORE INSERT ON public.finalization_exception_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_finalization_exception_resolution();
CREATE TRIGGER finalization_exception_resolutions_append_only
  BEFORE UPDATE OR DELETE ON public.finalization_exception_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER finalization_exception_resolutions_no_truncate
  BEFORE TRUNCATE ON public.finalization_exception_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- The runtime keeps the default SELECT and INSERT from 0001 and receives
-- nothing more. The trigger function is not callable directly.
REVOKE ALL ON FUNCTION app.stamp_finalization_exception_resolution() FROM PUBLIC;
