-- tidegrid:no-transaction
-- 0022 the provider message id index (W1-EMAIL-EVENTS)
--
-- One sent message per provider message id, across tenants, so an email
-- event joins at most one message (app.resolve_email_message, 0021). Built
-- CONCURRENTLY under the D6 A standing rule, because email_messages is a
-- pilot-volume table. A null id (any message not yet sent) is not indexed
-- against another. If the build finds two sent messages with one id it fails,
-- leaves an invalid index, and the runner names the repair
-- (packages/database/README.md, "Repair after a failed concurrent build").
-- IF NOT EXISTS: a rerun after a lost connection between the build and its
-- record only records the file.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS email_messages_provider_message_once
  ON public.email_messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL
