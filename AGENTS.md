# TideGrid agent instructions

## Product status

- TideGrid is exploratory. Do not assume the owner has committed to launching or funding it.
- A demo-grade Core build is authorized as of 2026-09-20 within the boundaries in the [demo build plan](docs/v2/12-demo-build-plan.md): synthetic data, Stripe test mode, no SMS, no live payments, no customer data, and no gate claims. Production work beyond that plan still waits for the applicable roadmap gate.
- Build goals follow the [build execution and agent plan](docs/v2/10-build-execution-and-agent-plan.md), including its Claude Code route and the agent definitions in `.claude/agents`. One goal per branch, an independent review before handoff, commits and pull requests only when the owner authorizes them for that goal.

## Authority order

- Follow the [authority order](docs/v2/00-index.md#authority-and-historical-artifacts) in the V2 index. The [decision register](docs/v2/06-decision-register.md) wins every conflict; the other numbered V2 documents come next.
- Read the current repository artifacts before making product, commercial, or architecture claims.

## Repository rules

- `docs/v1` and `docs/archive` are read-only history. Never edit them to match V2; record the current decision in V2 and link back.
- `prototypes/guest-flow` is a throwaway demo, not production code. Do not treat its behavior as an implementation contract.
- The demo build lives in `apps/`, `packages/`, `tools/`, and `config/`. Migrations in `packages/database/migrations` are forward-only once merged; write a new file instead of editing an applied one. Runtime code connects as `tidegrid_app`, which is created by migration 0001 in SQL and must never be created through the Neon console or API.
- Tenant isolation follows the contract in [packages/database/README.md](packages/database/README.md): every tenant-owned read or write runs inside `inTenantTransaction`, every tenant table has forced row-level security, the runtime never receives DELETE, and credential tables are reachable only through the functions in schema `app`. Integration tests check these rules from the catalog.
- Integration suites run only against a throwaway Neon branch with `TIDEGRID_EPHEMERAL_DB=1`. They rotate the runtime role's password, so never point them at the main branch.
- Model and tool names belong only in [docs/v2/10-build-execution-and-agent-plan.md](docs/v2/10-build-execution-and-agent-plan.md). Elsewhere, say "the build execution and agent plan" and link to it.
- Agent definition files in `.claude/agents` carry standing role instructions only. Goal scope, owned paths, and invariants come from the goal packet, not from those files.
- No customer data, credentials, or personal filing details in this repository. The owner keeps those in a private location outside the repo.

## Commands

Run from the repository root with Node 24 (`.nvmrc`) and pnpm (`corepack enable`).

```sh
pnpm install                      # workspace dependencies
pnpm check                        # typecheck, lint, unit tests, doc links, prototype checks
pnpm typecheck                    # every package
pnpm lint                         # Biome; pnpm lint:fix to apply
pnpm test                         # unit tests (Workers tests run in workerd)
pnpm contracts:generate           # regenerate packages/contracts/generated/openapi.json
DATABASE_URL=... pnpm db:migrate  # apply SQL migrations (admin connection)
DATABASE_URL=... pnpm db:seed     # deterministic synthetic seed
DATABASE_URL=... pnpm test:integration   # migration tests against a live branch
pnpm --filter @tidegrid/database neon:branch create <name>   # expiring Neon branch (needs NEON_API_KEY, NEON_PROJECT_ID)
pnpm --filter @tidegrid/api-worker dev                       # local API on :8787 (reads apps/api-worker/.dev.vars)
```

Secrets never enter the repository. Local values live in gitignored `.dev.vars` and `.env.local` files; deployed values are Wrangler secrets. Deploy a Worker only when the owner asks: `pnpm --filter @tidegrid/api-worker run release`, and the same for `guest-site` and `operator-site`. The script is named `release` because `pnpm deploy` is a built-in pnpm command. `pnpm release:dry` dry-runs all three.

The throwaway prototype keeps its own commands until it is retired:

```sh
pnpm test:prototype
pnpm check:prototype
python3 -m http.server 4287 --bind 127.0.0.1 --directory prototypes/guest-flow
pnpm deploy:demo:dry
```

## Writing rules

- No em dashes anywhere. Short sentences.
- Label proposed features as proposed. Keep the nonbinding, exploratory framing.
- Separate observed evidence (interviews, prototype sessions, primary sources) from hypotheses and proposed solutions.
