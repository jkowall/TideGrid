-- TideGrid ops signals (W3-OPS-5). Read-only, counts and ages only: no tenant
-- id, booking, guest, address, or provider id leaves the database.
--
-- Run as a role that bypasses row-level security (the owner), in a read-only
-- session. One line per signal: name|value|limit. check-signals.sh turns a
-- value above its limit into an alert. Times come from the database clock.
--
-- Limits are coordinator defaults (decision register, 2026-11-15 W3-OPS-5).

-- Payment taken but no booking: a checkout's payment succeeded more than 15
-- minutes ago and the checkout is neither confirmed nor handed to the
-- finalization exception path (unfulfilled, with its refund).
select format('finalization_gap|%s|0', count(*))
  from public.payments p
  join public.checkout_sessions s on s.tenant_id = p.tenant_id and s.id = p.checkout_session_id
 where p.state = 'succeeded'
   and p.succeeded_at < now() - interval '15 minutes'
   and s.state not in ('confirmed', 'unfulfilled');

-- Background jobs: the oldest due, undelivered outbox event, in minutes.
select format('outbox_oldest_minutes|%s|30',
         coalesce(floor(extract(epoch from now() - min(available_at)) / 60)::int, 0))
  from public.outbox_events
 where delivered_at is null and available_at <= now();

-- Dead letters nobody has replayed yet.
select format('dead_letters_open|%s|0', count(*))
  from public.outbox_dead_letters
 where replayed_at is null;

-- The email provider refused for the whole account in the last hour (a daily
-- limit, an unverified sender, a suspended account).
select format('email_account_fault|%s|0', count(*))
  from public.email_messages
 where last_error_code in ('provider_quota_exceeded', 'sender_not_verified', 'provider_account_suspended')
   and last_attempt_at > now() - interval '1 hour'
   and state in ('queued', 'sending');

-- The oldest email that is due and still waiting, in minutes.
select format('email_oldest_due_minutes|%s|60',
         coalesce(floor(extract(epoch from now() - min(coalesce(next_attempt_at, created_at))) / 60)::int, 0))
  from public.email_messages
 where state = 'queued' and coalesce(next_attempt_at, created_at) <= now();

-- The cron runs every 15 minutes; minutes since any sweep last took a turn.
-- 0 before any sweep has ever run.
select format('cron_quiet_minutes|%s|45',
         coalesce(floor(extract(epoch from now() - max(last_turn_at)) / 60)::int, 0))
  from public.sweep_turns;
