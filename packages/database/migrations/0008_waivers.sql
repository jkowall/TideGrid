-- Waiver evidence (G2.15)
--
-- Immutable waiver templates; one waiver request per participant of a
-- confirmed booking for the version that applied when it was assigned; the
-- delivery generations that email a request; short-lived access tokens and
-- the signing sessions they open; and append-only signed evidence that keeps
-- the PDF of what was signed. Design authority: docs/v2/04-architecture.md
-- (waivers; the retained invariants), docs/v2/02-product-scope.md (native
-- liability waivers), and the waiver contract in
-- packages/domain-waivers/README.md.
--
-- Chain of custody. Nothing here becomes signed on a client's say:
--
--   request signed   requires  its evidence row, written in the same transaction
--   evidence         requires  a pending request, an unexpired and unrevoked
--                              signing session for that request, the signer the
--                              request requires, the version's exact hash and
--                              acknowledgments, and a PDF whose SHA-256 the row
--                              carries
--   signing session  requires  an access token for that request, redeemed in the
--                              same transaction
--   access token     requires  a pending request; it is redeemed at most once
--
-- State machines, one way, enforced by triggers for every role:
--
--   request:      pending -> signed | revoked | superseded; signed -> revoked
--   access token: issued -> redeemed | revoked (an unredeemed token only)
--   session:      open -> revoked; it also lapses at its expiry instant
--
-- A late provider callback cannot regress a signed request: nothing moves a
-- request back to pending, and evidence never changes for any role, the owner
-- included. Delivery status lives with the message, never on the request.
--
-- Only hashes of tokens and session secrets are stored. The PDF lives in
-- Postgres for the demo, in the evidence row, under the same immutability;
-- the waiver contract records why and how it moves to R2.
--
-- Lock order for every command: the booking's advisory lock (assignment
-- only), then the request (FOR NO KEY UPDATE), then its tokens and sessions.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, SELECT and INSERT from the default privileges,
-- UPDATE only on the columns that carry a transition, and no DELETE or
-- TRUNCATE for any role.

-- Templates -----------------------------------------------------------------------

-- A waiver an operator requires: for every product (scope operator) or for one
-- product (scope product), which then takes precedence. Its text lives in its
-- versions. Written by staff or onboarding, never by a guest.
CREATE TABLE public.waiver_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  scope text NOT NULL CHECK (scope IN ('operator', 'product')),
  product_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, id),
  CHECK ((scope = 'product') = (product_id IS NOT NULL))
);
CREATE UNIQUE INDEX waiver_templates_one_operator ON public.waiver_templates (tenant_id)
  WHERE scope = 'operator';
CREATE UNIQUE INDEX waiver_templates_one_per_product
  ON public.waiver_templates (tenant_id, product_id) WHERE scope = 'product';

-- One immutable version of a template's text. The operator approves the text;
-- TideGrid renders it and does not draft or certify it. content_sha256 is the
-- SHA-256 of the canonical content (title, body, and acknowledgments; see
-- app.check_waiver_template_version), set by the database, so every request
-- and every piece of evidence names the exact text. The highest version in
-- effect is the one new requests get; a version takes effect no earlier than
-- the moment it is written.
--
-- Signer rules: an adult signs for themselves (adult_signer participant) and a
-- parent or legal guardian signs for a minor (minor_signer guardian). The
-- re-sign policy every_booking means a signature covers one booking's
-- request; reuse across bookings waits for verified customer identity.
CREATE TABLE public.waiver_template_versions (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
  -- Paragraphs separated by blank lines; plain text, never markup.
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000
    AND body !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  acknowledgments text[] NOT NULL
    CHECK (cardinality(acknowledgments) BETWEEN 1 AND 10
           AND array_position(acknowledgments, NULL) IS NULL),
  -- How the PDF is laid out; a new layout is a new rendering version.
  rendering_version integer NOT NULL CHECK (rendering_version = 1),
  adult_signer text NOT NULL DEFAULT 'participant' CHECK (adult_signer = 'participant'),
  minor_signer text NOT NULL DEFAULT 'guardian' CHECK (minor_signer = 'guardian'),
  resign_policy text NOT NULL DEFAULT 'every_booking' CHECK (resign_policy = 'every_booking'),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, template_id, version),
  UNIQUE (tenant_id, template_id, version, content_sha256),
  FOREIGN KEY (tenant_id, template_id) REFERENCES public.waiver_templates (tenant_id, id),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

-- Requests ------------------------------------------------------------------------

-- The assignment: one participant of one confirmed booking must sign one
-- version. Created atomically with the booking's confirmation or the
-- participant's addition. The assignment key (tenant, booking, participant,
-- version) makes a retry find the first request instead of adding another,
-- and at most one request per participant and booking is live (pending or
-- signed). required_signer is participant for an adult and guardian for a
-- minor, from the version's signer rules.
CREATE TABLE public.waiver_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version integer NOT NULL,
  content_sha256 text NOT NULL,
  required_signer text NOT NULL CHECK (required_signer IN ('participant', 'guardian')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'signed', 'revoked', 'superseded')),
  revoked_reason text CHECK (revoked_reason IN ('participant_removed', 'booking_canceled')),
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  revoked_at timestamptz,
  superseded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, booking_id, participant_id),
  CONSTRAINT waiver_requests_assignment_key
    UNIQUE (tenant_id, booking_id, participant_id, template_id, template_version),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id, template_version, content_sha256)
    REFERENCES public.waiver_template_versions (tenant_id, template_id, version, content_sha256),
  -- A replacement is a request for the same booking and participant. Checked
  -- at commit, because the replacement can be written only after this request
  -- stops being live (waiver_requests_one_live).
  CONSTRAINT waiver_requests_superseded_by_fkey
    FOREIGN KEY (tenant_id, superseded_by, booking_id, participant_id)
    REFERENCES public.waiver_requests (tenant_id, id, booking_id, participant_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (superseded_by IS DISTINCT FROM id),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)),
  CHECK ((state = 'superseded') = (superseded_at IS NOT NULL AND superseded_by IS NOT NULL)),
  CHECK (state <> 'signed' OR signed_at IS NOT NULL),
  CHECK (state <> 'pending' OR signed_at IS NULL)
);
CREATE UNIQUE INDEX waiver_requests_one_live
  ON public.waiver_requests (tenant_id, booking_id, participant_id)
  WHERE state IN ('pending', 'signed');
CREATE INDEX waiver_requests_template_pending_idx
  ON public.waiver_requests (tenant_id, template_id, template_version)
  WHERE state = 'pending';

-- Access tokens -------------------------------------------------------------------

-- An opaque entry token for one request, for one purpose (sign). Only the
-- SHA-256 of the token is stored. It is redeemed at most once, by an explicit
-- POST, never by a GET; a newer delivery, the request's end, or the signature
-- revokes it. It lives at most 14 days and never past its trip's end (the
-- service picks the instant).
CREATE TABLE public.waiver_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  request_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'sign'),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN (
    'replaced', 'signed', 'participant_removed', 'booking_canceled', 'superseded')),
  UNIQUE (tenant_id, id),
  CONSTRAINT waiver_access_tokens_hash_key UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, request_id) REFERENCES public.waiver_requests (tenant_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (redeemed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX waiver_access_tokens_request_idx ON public.waiver_access_tokens (tenant_id, request_id);

-- Deliveries ----------------------------------------------------------------------

-- One intentional send of a request: generation 1 when it is assigned, and
-- each audited resend after it. A retry of the same generation never adds a
-- row; the message it queued carries the generation's idempotency key
-- (waiver:<request>:<generation>). Resends are rate limited here, for every
-- writer: at least 10 minutes apart and at most 5 generations per request.
-- The recipient is the address the request went to; the message records
-- whether it was accepted, delivered, or failed.
CREATE TABLE public.waiver_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  request_id uuid NOT NULL,
  generation smallint NOT NULL CHECK (generation BETWEEN 1 AND 5),
  kind text NOT NULL CHECK (kind IN ('initial', 'resend')),
  recipient_email text NOT NULL
    CHECK (char_length(recipient_email) <= 254
           AND recipient_email = lower(recipient_email)
           AND recipient_email ~ '^[\x21-\x7e]+$'
           AND recipient_email ~ '^[^@]+@[^@]+\.[^@]+$'),
  token_id uuid NOT NULL,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Who asked for this generation, from the transaction's context.
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text,
  api_request_id text,
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  UNIQUE (tenant_id, id),
  CONSTRAINT waiver_deliveries_generation_key UNIQUE (tenant_id, request_id, generation),
  UNIQUE (tenant_id, token_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES public.waiver_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, token_id) REFERENCES public.waiver_access_tokens (tenant_id, id),
  CHECK ((kind = 'initial') = (generation = 1)),
  CHECK (kind = 'initial' OR reason IS NOT NULL)
);

-- Signing sessions ----------------------------------------------------------------

-- What redeeming a token opens: a restricted session bound to one tenant,
-- booking, participant, request, and purpose, for the signer the request
-- requires. Only the SHA-256 of its secret is stored. It lasts at most two
-- hours (the service gives it one) and is revoked when its request ends.
CREATE TABLE public.waiver_signing_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  token_id uuid NOT NULL,
  request_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'sign'),
  signer_role text NOT NULL CHECK (signer_role IN ('participant', 'guardian')),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN (
    'participant_removed', 'booking_canceled', 'superseded', 'recipient_changed')),
  UNIQUE (tenant_id, id),
  -- One session per token: a token opens one session, once.
  UNIQUE (tenant_id, token_id),
  CONSTRAINT waiver_signing_sessions_secret_key UNIQUE (secret_hash),
  FOREIGN KEY (tenant_id, token_id) REFERENCES public.waiver_access_tokens (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, booking_id, participant_id)
    REFERENCES public.waiver_requests (tenant_id, id, booking_id, participant_id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX waiver_signing_sessions_request_idx
  ON public.waiver_signing_sessions (tenant_id, request_id);

-- Evidence ------------------------------------------------------------------------

-- A signature, once, for one request: who the participant was, who signed and
-- in what capacity, the exact version and its hash, the acknowledgments and
-- the electronic-signature consent accepted, the typed signature, how the
-- signer reached it (an email link to the request's address, with the signer
-- confirming who they are), where from, when by the database clock, and the
-- rendered PDF with its SHA-256. Append-only for every role, the owner
-- included: a correction is a new version and a new request, never an edit.
CREATE TABLE public.waiver_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  request_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version integer NOT NULL,
  content_sha256 text NOT NULL,
  rendering_version integer NOT NULL CHECK (rendering_version = 1),
  participant_name text NOT NULL
    CHECK (char_length(participant_name) BETWEEN 1 AND 120 AND participant_name !~ '[[:cntrl:]]'),
  participant_minor boolean NOT NULL,
  signer_role text NOT NULL CHECK (signer_role IN ('participant', 'guardian')),
  signer_name text NOT NULL
    CHECK (char_length(signer_name) BETWEEN 1 AND 120 AND signer_name !~ '[[:cntrl:]]'),
  guardian_relationship text CHECK (guardian_relationship IN ('parent', 'legal_guardian')),
  signature_method text NOT NULL CHECK (signature_method = 'typed_name'),
  signature_text text NOT NULL
    CHECK (char_length(signature_text) BETWEEN 1 AND 120 AND signature_text !~ '[[:cntrl:]]'),
  acknowledgments text[] NOT NULL,
  consent_version text NOT NULL CHECK (consent_version ~ '^[a-z0-9.-]{1,32}$'),
  consent_text text NOT NULL CHECK (char_length(consent_text) BETWEEN 1 AND 1000),
  access_method text NOT NULL CHECK (access_method = 'email_link'),
  -- The address the link went to: following it shows access to that mailbox.
  recipient_email text NOT NULL CHECK (char_length(recipient_email) <= 254),
  match_method text NOT NULL CHECK (match_method = 'signer_confirmed'),
  signed_at timestamptz NOT NULL DEFAULT now(),
  source_ip text CHECK (char_length(source_ip) <= 64),
  user_agent text CHECK (char_length(user_agent) <= 512 AND user_agent !~ '[[:cntrl:]]'),
  document bytea NOT NULL CHECK (octet_length(document) BETWEEN 64 AND 2000000),
  document_sha256 text NOT NULL,
  UNIQUE (tenant_id, id),
  CONSTRAINT waiver_evidence_once UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id, booking_id, participant_id)
    REFERENCES public.waiver_requests (tenant_id, id, booking_id, participant_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES public.waiver_signing_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id, template_version, content_sha256)
    REFERENCES public.waiver_template_versions (tenant_id, template_id, version, content_sha256),
  CHECK (document_sha256 = encode(sha256(document), 'hex')),
  CHECK ((signer_role = 'guardian') = (guardian_relationship IS NOT NULL)),
  -- A minor never signs for themselves, and a guardian signs only for a minor.
  CHECK ((signer_role = 'guardian') = participant_minor)
);
CREATE INDEX waiver_evidence_booking_idx ON public.waiver_evidence (tenant_id, booking_id);

-- Rules ---------------------------------------------------------------------------
--
-- Every trigger function runs as the writer, inside its tenant transaction, so
-- row-level security applies, and filters by the row's tenant explicitly.
-- Raised errors carry a constraint name so callers and tests can tell them
-- apart. Times come from the database clock.

CREATE FUNCTION app.check_waiver_template() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_templates_stamp BEFORE INSERT ON public.waiver_templates
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_template();
CREATE TRIGGER waiver_templates_actor BEFORE INSERT ON public.waiver_templates
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor();

-- A version: its number follows the template's highest, its acknowledgments
-- are short single lines, it takes effect no earlier than now, and its hash is
-- computed here from the canonical content, so no writer can choose it. The
-- canonical content is UTF-8 text: a format line, then the title, the body,
-- and each acknowledgment in order, each as "<label>:<byte length>:<text>" on
-- its own line. packages/domain-waivers/src/content.ts computes the same.
CREATE FUNCTION app.check_waiver_template_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  latest integer;
  ack text;
  canonical text;
BEGIN
  SELECT max(v.version) INTO latest
    FROM public.waiver_template_versions v
   WHERE v.tenant_id = NEW.tenant_id AND v.template_id = NEW.template_id;
  IF NEW.version IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'waiver template % takes version %, not %',
      NEW.template_id, coalesce(latest, 0) + 1, NEW.version
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_template_versions_sequence';
  END IF;
  FOREACH ack IN ARRAY NEW.acknowledgments LOOP
    IF char_length(ack) NOT BETWEEN 1 AND 300 OR ack ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'an acknowledgment is one line of 1 to 300 characters'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_template_versions_acknowledgments';
    END IF;
  END LOOP;
  NEW.created_at := pg_catalog.clock_timestamp();
  NEW.effective_from := greatest(NEW.effective_from, now());
  IF NEW.effective_until IS NOT NULL AND NEW.effective_until <= NEW.effective_from THEN
    RAISE EXCEPTION 'a waiver version must end after it takes effect'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_template_versions_effective';
  END IF;
  canonical := 'tidegrid.waiver.content.v1' || E'\n'
    || 'title:' || octet_length(NEW.title)::text || ':' || NEW.title || E'\n'
    || 'body:' || octet_length(NEW.body)::text || ':' || NEW.body;
  FOREACH ack IN ARRAY NEW.acknowledgments LOOP
    canonical := canonical || E'\n' || 'ack:' || octet_length(ack)::text || ':' || ack;
  END LOOP;
  NEW.content_sha256 := encode(sha256(convert_to(canonical, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_template_versions_check BEFORE INSERT ON public.waiver_template_versions
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_template_version();
CREATE TRIGGER waiver_template_versions_actor BEFORE INSERT ON public.waiver_template_versions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor();

-- Requests: created pending for a confirmed booking and a version in effect;
-- afterwards only the state moves, one way, and the times are stamped here.
CREATE FUNCTION app.check_waiver_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.revoked_reason IS NOT NULL
       OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'a waiver request starts pending'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.signed_at := NULL;
    NEW.revoked_at := NULL;
    NEW.superseded_at := NULL;
    IF NOT EXISTS (
         SELECT 1 FROM public.bookings b
          WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
            AND b.state = 'confirmed') THEN
      RAISE EXCEPTION 'waiver requests are assigned only for a confirmed booking'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_booking';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM public.waiver_template_versions v
          WHERE v.tenant_id = NEW.tenant_id AND v.template_id = NEW.template_id
            AND v.version = NEW.template_version
            AND v.effective_from <= now()
            AND (v.effective_until IS NULL OR v.effective_until > now())) THEN
      RAISE EXCEPTION 'waiver version %/% is not in effect', NEW.template_id, NEW.template_version
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_version';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.required_signer IS DISTINCT FROM OLD.required_signer
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a waiver request never changes; only its state moves'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_immutable';
  END IF;
  IF NEW.state = OLD.state THEN
    IF NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
       OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
      RAISE EXCEPTION 'a waiver request''s reason changes only with its state'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_transition';
    END IF;
    NEW.signed_at := OLD.signed_at;
    NEW.revoked_at := OLD.revoked_at;
    NEW.superseded_at := OLD.superseded_at;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  NEW.signed_at := OLD.signed_at;
  NEW.revoked_at := OLD.revoked_at;
  NEW.superseded_at := OLD.superseded_at;
  IF OLD.state = 'pending' AND NEW.state = 'signed' THEN
    IF NEW.revoked_reason IS NOT NULL OR NEW.superseded_by IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.waiver_evidence e
          WHERE e.tenant_id = NEW.tenant_id AND e.request_id = NEW.id) THEN
      RAISE EXCEPTION 'waiver request % is signed only with its evidence', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_signed_evidence';
    END IF;
    NEW.signed_at := now();
  ELSIF OLD.state IN ('pending', 'signed') AND NEW.state = 'revoked' THEN
    IF NEW.revoked_reason IS NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'a revoked waiver request names why'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_transition';
    END IF;
    NEW.revoked_at := now();
  ELSIF OLD.state = 'pending' AND NEW.state = 'superseded' THEN
    -- The replacement is written next, in this transaction; the deferred
    -- foreign key checks at commit that it exists for the same participant,
    -- and the assignment key keeps it on another version.
    IF NEW.revoked_reason IS NOT NULL OR NEW.superseded_by IS NULL THEN
      RAISE EXCEPTION 'a superseded waiver request names its replacement'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_transition';
    END IF;
    NEW.superseded_at := now();
  ELSE
    RAISE EXCEPTION 'a waiver request cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_requests_check BEFORE INSERT OR UPDATE ON public.waiver_requests
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_request();

-- Access tokens: issued for a pending request; redeemed once while unexpired
-- and unrevoked, or revoked once while unredeemed. Nothing else changes.
CREATE FUNCTION app.check_waiver_access_token() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.redeemed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'an access token starts unredeemed and unrevoked'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_transition';
    END IF;
    IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '14 days' THEN
      RAISE EXCEPTION 'an access token lives more than no time and at most 14 days'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_lifetime';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM public.waiver_requests r
          WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id
            AND r.state = 'pending') THEN
      RAISE EXCEPTION 'access tokens are issued only for a pending waiver request'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_request';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'an access token never changes; it is only redeemed or revoked'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_immutable';
  END IF;
  IF OLD.redeemed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'access token % was already used or revoked', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_transition';
  END IF;
  IF NEW.redeemed_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'access token % has expired', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_expired';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM public.waiver_requests r
          WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.request_id
            AND r.state = 'pending') THEN
      RAISE EXCEPTION 'access token % is for a request that is no longer pending', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_request';
    END IF;
    NEW.redeemed_at := now();
  ELSIF NEW.revoked_at IS NOT NULL AND NEW.redeemed_at IS NULL THEN
    NEW.revoked_at := now();
  ELSE
    RAISE EXCEPTION 'an access token is either redeemed or revoked, once'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_access_tokens_transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_access_tokens_check BEFORE INSERT OR UPDATE ON public.waiver_access_tokens
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_access_token();

-- Deliveries: the next generation of a pending request, carrying a token for
-- that request issued in this transaction. A resend follows the previous
-- generation by at least 10 minutes; the generation number caps them at 5.
CREATE FUNCTION app.check_waiver_delivery() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  latest record;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.api_request_id := app.setting_or_null('app.request_id');
  -- Serializes generations of one request with each other and with signing.
  PERFORM 1 FROM public.waiver_requests r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id AND r.state = 'pending'
      FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waiver request % is not pending; nothing to send', NEW.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_request';
  END IF;
  SELECT d.generation, d.created_at INTO latest
    FROM public.waiver_deliveries d
   WHERE d.tenant_id = NEW.tenant_id AND d.request_id = NEW.request_id
   ORDER BY d.generation DESC
   LIMIT 1;
  IF NEW.generation IS DISTINCT FROM coalesce(latest.generation, 0) + 1 THEN
    RAISE EXCEPTION 'waiver request % takes delivery generation %, not %',
      NEW.request_id, coalesce(latest.generation, 0) + 1, NEW.generation
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_sequence';
  END IF;
  IF latest.created_at IS NOT NULL AND latest.created_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'waiver request % was sent less than 10 minutes ago', NEW.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_rate';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.waiver_access_tokens t
        WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.token_id
          AND t.request_id = NEW.request_id
          AND t.created_at = now()
          AND t.redeemed_at IS NULL AND t.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a delivery carries a fresh token for its own request'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_token';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_deliveries_check BEFORE INSERT ON public.waiver_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_delivery();

-- Signing sessions: opened only by redeeming a token for the same request in
-- the same transaction, for the signer the request requires; afterwards only
-- revoked, once.
CREATE FUNCTION app.check_waiver_signing_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a signing session starts unrevoked'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_transition';
    END IF;
    IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '2 hours' THEN
      RAISE EXCEPTION 'a signing session lasts more than no time and at most two hours'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_lifetime';
    END IF;
    IF NOT EXISTS (
         SELECT 1
           FROM public.waiver_access_tokens t
           JOIN public.waiver_requests r ON r.tenant_id = t.tenant_id AND r.id = t.request_id
          WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.token_id
            AND t.request_id = NEW.request_id
            AND t.purpose = NEW.purpose
            AND t.redeemed_at = now()
            AND r.state = 'pending'
            AND r.required_signer = NEW.signer_role) THEN
      RAISE EXCEPTION 'a signing session needs its token redeemed now, for its pending request and signer'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_token';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.token_id IS DISTINCT FROM OLD.token_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.signer_role IS DISTINCT FROM OLD.signer_role
     OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a signing session never changes; it is only revoked'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a signing session is revoked once'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_transition';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_signing_sessions_check
  BEFORE INSERT OR UPDATE ON public.waiver_signing_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_signing_session();

-- Evidence: written once, for a pending request, by an open session of that
-- request, for the signer it requires, with the request's exact version, hash,
-- and acknowledgments. The request's row lock orders it against every other
-- change to the request. The PDF's hash is checked by the table's CHECK.
CREATE FUNCTION app.check_waiver_evidence() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  r record;
  v record;
BEGIN
  NEW.signed_at := now();
  SELECT x.state, x.booking_id, x.participant_id, x.template_id, x.template_version,
         x.content_sha256, x.required_signer
    INTO r
    FROM public.waiver_requests x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.request_id
     FOR NO KEY UPDATE;
  IF NOT FOUND OR r.state <> 'pending' THEN
    RAISE EXCEPTION 'waiver request % is not pending; it takes no signature', NEW.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_request';
  END IF;
  IF r.booking_id <> NEW.booking_id OR r.participant_id <> NEW.participant_id
     OR r.template_id <> NEW.template_id OR r.template_version <> NEW.template_version
     OR r.content_sha256 <> NEW.content_sha256 OR r.required_signer <> NEW.signer_role THEN
    RAISE EXCEPTION 'evidence names its request''s booking, participant, version, hash, and signer'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_request';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.waiver_signing_sessions s
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id
          AND s.request_id = NEW.request_id
          AND s.signer_role = NEW.signer_role
          AND s.revoked_at IS NULL
          AND s.expires_at > now()) THEN
    RAISE EXCEPTION 'evidence needs an open signing session for its request'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_session';
  END IF;
  SELECT x.acknowledgments, x.rendering_version INTO v
    FROM public.waiver_template_versions x
   WHERE x.tenant_id = NEW.tenant_id AND x.template_id = NEW.template_id
     AND x.version = NEW.template_version;
  IF v.acknowledgments IS DISTINCT FROM NEW.acknowledgments
     OR v.rendering_version IS DISTINCT FROM NEW.rendering_version THEN
    RAISE EXCEPTION 'evidence carries its version''s acknowledgments and rendering'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_evidence_check BEFORE INSERT ON public.waiver_evidence
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_evidence();

-- Checked at commit: evidence and its request's signature commit together, so
-- a transaction cannot leave evidence beside a request that is still pending.
CREATE FUNCTION app.check_waiver_evidence_signed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.waiver_requests r
        WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id
          AND r.signed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'evidence % commits only with its request signed', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_signed';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER waiver_evidence_signed
  AFTER INSERT ON public.waiver_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_evidence_signed();

-- Row-level security and append-only guards ---------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'waiver_templates', 'waiver_template_versions', 'waiver_requests',
    'waiver_access_tokens', 'waiver_deliveries', 'waiver_signing_sessions', 'waiver_evidence'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      ' USING (tenant_id = (SELECT app.current_tenant_id()))'
      ' WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I'
      ' FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
  -- These never change once written, for any role.
  FOREACH t IN ARRAY ARRAY[
    'waiver_templates', 'waiver_template_versions', 'waiver_deliveries', 'waiver_evidence'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_append_only', t);
  END LOOP;
END
$$;

-- Privileges ----------------------------------------------------------------------

-- SELECT and INSERT come from the default privileges in 0001. UPDATE is
-- granted on the columns that carry a transition; the triggers stamp the
-- times and refuse everything else.
GRANT UPDATE (state, revoked_reason, superseded_by) ON public.waiver_requests TO tidegrid_app;
GRANT UPDATE (redeemed_at, revoked_at, revoked_reason)
  ON public.waiver_access_tokens TO tidegrid_app;
GRANT UPDATE (revoked_at, revoked_reason) ON public.waiver_signing_sessions TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_waiver_template() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_template_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_access_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_delivery() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_signing_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_evidence_signed() FROM PUBLIC;
