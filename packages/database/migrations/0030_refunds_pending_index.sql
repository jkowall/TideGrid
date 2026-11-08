-- tidegrid:no-transaction
-- 0030 the pending refund index (W3-G2.9)
--
-- The checkout sweep checks each pending refund about once an hour
-- (0029), by when it was last checked, for one tenant or for the tenant
-- list. Built CONCURRENTLY under the D6 A standing rule, because
-- payment_refunds is a pilot-volume table. IF NOT EXISTS: a rerun after a
-- lost connection between the build and its record only records the file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_refunds_pending_idx
  ON public.payment_refunds (checked_at) INCLUDE (tenant_id)
  WHERE state = 'pending'
