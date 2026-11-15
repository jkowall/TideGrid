-- W3-OPS-4, phase 3 of sealing guest contact details (owner decision
-- 2026-11-15): the email outbox, and the places that match a guest's address.
--
-- A message written where the application has a field keyring keeps its
-- recipient's address and name, its subject, and both bodies in one sealed
-- value, content_sealed ({toEmail, toName, subject, html, text}), bound to
-- the tenant and this column. The delivery job opens it to send. In place of
-- the address, to_email then holds the address key, '<email token>@sealed.invalid':
-- the same key the application writes into waiver_deliveries.recipient_email,
-- waiver_reminders.recipient_email, and email_suppressions.address for that
-- address. Every rule that compares two addresses (the waiver sending limits,
-- a delivery naming its message, a reminder or renewal going to the latest
-- address, a suppression naming its bounced message's address) compares two
-- keys and keeps working unchanged; the address itself is never stored
-- there. The .invalid domain never resolves (RFC 2606), so a key can never
-- be mailed by mistake.
--
-- No existing row is rewritten: a message stays as it was written.

-- 0056's checks were added NOT VALID; the rows they had to hold are plain
-- and their new columns null, so validating them now only reads.
ALTER TABLE public.booking_participants VALIDATE CONSTRAINT booking_participants_contact_sealed_format;
ALTER TABLE public.booking_participants VALIDATE CONSTRAINT booking_participants_email_index_format;
ALTER TABLE public.booking_participants
  VALIDATE CONSTRAINT booking_participants_guardian_email_index_format;
ALTER TABLE public.booking_participants VALIDATE CONSTRAINT booking_participants_guardian;
ALTER TABLE public.email_messages VALIDATE CONSTRAINT email_messages_to_email_index_format;

-- The outbox. Each check is added NOT VALID, so adding it never scans the
-- table under lock; the next migration validates them.
ALTER TABLE public.email_messages
  ALTER COLUMN subject DROP NOT NULL,
  ALTER COLUMN html_body DROP NOT NULL,
  ALTER COLUMN text_body DROP NOT NULL,
  ADD COLUMN content_sealed text;
-- The bodies may be large; sealed JSON grows by about a third.
ALTER TABLE public.email_messages
  ADD CONSTRAINT email_messages_content_sealed_format
    CHECK (content_sealed ~ '^tgf1:[a-z0-9]{1,16}:[A-Za-z0-9_-]{24,}$'
           AND char_length(content_sealed) <= 600000) NOT VALID;

-- A message is plain (an address, its content, no sealed value) or sealed
-- (a key, no name or content, and the sealed value). A CHECK that is NULL
-- passes, so the whole test is coalesced to false.
ALTER TABLE public.email_messages
  ADD CONSTRAINT email_messages_content_place CHECK (coalesce(
    (content_sealed IS NULL
     AND subject IS NOT NULL AND html_body IS NOT NULL AND text_body IS NOT NULL
     AND to_email !~ '@sealed\.invalid$')
    OR (content_sealed IS NOT NULL
        AND subject IS NULL AND html_body IS NULL AND text_body IS NULL AND to_name IS NULL
        AND to_email ~ '^[0-9a-f]{64}@sealed\.invalid$'
        AND (to_email_index IS NULL OR to_email = to_email_index || '@sealed.invalid')),
    false)) NOT VALID;

-- The application writes content_sealed once, with the message: the table's
-- SELECT and INSERT grants cover it, and no UPDATE grant names it, as none
-- names the content it replaces.
