-- tidegrid:no-transaction
-- 0032 the pending payment check index (W3-G2.10)
--
-- The reconciliation sweep's hourly look at pending payments the provider
-- knows (0031), by when each was last checked. payments is a pilot-volume
-- table, so the index is built CONCURRENTLY, in a file of its own (rule R4).
CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_pending_check_idx
  ON public.payments (checked_at NULLS FIRST) INCLUDE (tenant_id, created_at)
  WHERE state = 'pending' AND provider_payment_id IS NOT NULL
