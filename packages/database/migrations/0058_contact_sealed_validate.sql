-- W3-OPS-4, phase 4 of sealing guest contact details: 0057 added its checks
-- on the email outbox NOT VALID, so adding them never scanned the table under
-- lock. Every row already there is a plain message with no sealed value,
-- which both checks admit, so validating them now only reads.
ALTER TABLE public.email_messages VALIDATE CONSTRAINT email_messages_content_sealed_format;
ALTER TABLE public.email_messages VALIDATE CONSTRAINT email_messages_content_place;
