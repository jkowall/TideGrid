-- TideGrid ops signals (W3-OPS-5). Read-only, counts and ages only: no tenant
-- id, booking, guest, address, or provider id leaves the database.
--
-- Run as a role that bypasses row-level security (the owner), in a read-only
-- session. One line per signal: name|value|limit. check-signals.sh turns a
-- value above its limit into an alert, and refuses any other line shape.
-- Times come from the database clock.
--
-- Limits are coordinator defaults (decision register, 2026-11-15 W3-OPS-5).

-- Paid, no booking (1 of 2): the provider told TideGrid about a payment more
-- than 15 minutes ago and the event is still unprocessed. The checkout sweep
-- reprocesses such events; one still waiting means finalization is stuck.
select format('payment_events_stuck|%s|0', count(*))
  from public.provider_events
 where processing_state = 'received'
   and verified_at < now() - interval '15 minutes';

-- Paid, no booking (2 of 2): reconciliation asked the provider and the
-- provider says paid, but no payment event ever arrived (a webhook that is
-- misconfigured or lost), and the payment still reads pending here.
select format('paid_without_event|%s|0', count(*))
  from public.payment_reconciliation_exceptions x
  join public.payments p on p.tenant_id = x.tenant_id and p.id = x.payment_id
 where x.reason = 'succeeded_without_event'
   and p.state = 'pending';

-- Background jobs handed to the queue but not delivered after 30 minutes.
-- Counts only published events: no deployed API binds the outbox queue yet,
-- so unpublished events wait by design. Events with an open dead letter are
-- left to dead_letters_open.
select format('outbox_stuck_minutes|%s|30',
         coalesce(floor(extract(epoch from now() - min(e.published_at)) / 60)::int, 0))
  from public.outbox_events e
 where e.published_at is not null
   and e.delivered_at is null
   and not exists (select 1 from public.outbox_dead_letters d
                    where d.tenant_id = e.tenant_id and d.outbox_event_id = e.id
                      and d.replayed_at is null);

-- Background jobs that failed for good and wait for a reviewed replay.
select format('dead_letters_open|%s|0', count(*))
  from public.outbox_dead_letters
 where replayed_at is null;

-- The email provider refused for the whole account in the last hour: a
-- daily limit or a suspended account. sender_not_verified is left out: from
-- an operator's own domain it holds only that operator.
select format('email_account_fault|%s|0', count(*))
  from public.email_messages
 where last_error_code in ('provider_quota_exceeded', 'provider_account_suspended')
   -- updated_at, not last_attempt_at: an account fault gives the first
   -- attempt back, which clears last_attempt_at (migration 0019).
   and updated_at > now() - interval '1 hour'
   and state in ('queued', 'sending');
