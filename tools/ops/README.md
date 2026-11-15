# Ops signals (W3-OPS-5)

`signals.sql` reads TideGrid's health signals as counts and ages, and `check-signals.sh` fails when one is over its limit. The [ops checks runbook](../../docs/runbooks/ops-checks.md) lists each signal, its limit, and what to do. The synthetic booking check lives in the release tooling: `pnpm --filter @tidegrid/release synthetic` ([source](../release/src/synthetic.ts)).

Run locally against the throwaway database: `eval "$(tools/local-db/local-db.sh env)" && tools/ops/check-signals.sh`.
