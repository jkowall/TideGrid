# ADR 0005: Stripe Connect direct charges

**Status:** Accepted  
**Date:** 2026-07-15

## Context

The boat operator sells its own service and TideGrid collects a plan-specific 0.75% to 3.00% platform fee on eligible value. The pricing plan, schedule version, rate, and eligible base are snapshotted for each fee.

## Decision

Use Connect direct charges in the connected operator account with `application_fee_amount`. Use connected-account Terminal resources. Keep SaaS Billing separate.

## Alternatives

Destination charges; separate charges and transfers.

## Benefits

Operator remains merchant of record; charge, dispute, and refund responsibility align with the seller.

## Risks and consequences

Platform reporting must query connected-account context. Application-fee refunds are explicit. Stripe configuration and legal review are launch gates.

## Revisit when

TideGrid becomes merchant of record, supports multi-operator carts, or accepts liability for negative balances.
