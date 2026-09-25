# TideGrid

TideGrid is an exploratory, US-first product idea for branded passenger-vessel booking: one multi-tenant service that gives each small operator a branded guest booking experience, with its boats managed inside that experience. Nothing here commits anyone to building, launching, or funding it, and there is no production application. The repository holds the current planning package, a preserved earlier design package, an archive of source prompts and brand material, a throwaway guest workflow prototype, and the scripts that check them.

## Status

A demo-grade Core build is authorized within the boundaries of the [demo build plan](docs/v2/12-demo-build-plan.md); it uses synthetic data and test-mode providers and passes no gate. TideGrid is in the validation stage: operator interviews, written conditional commitments, and three paid Native pilot operators across two operator types come before any production build, and the full sequence is defined in the [roadmap gates](docs/v2/05-roadmap-validation.md#gates). Three named gates govern production. The **Core live gate** passes before an operator takes its first real booking and covers tenant isolation, catalog and availability, pricing, booking and payment, policies, guest self-service, native waivers, transactional email, the operator console, migration, the branded PWA, and operations. **Staged Core modules** (transactional SMS, pooled equipment, marine conditions and disruptions, tips, and trip cards) are required for pilot completion, but an operator may go live with a module disabled and enable it after that module passes its own acceptance. The **Native pilot gate** covers the operator-owned iOS and Android apps, push, deep links, and the native guest journeys; it gates the Native add-on for that operator and does not block the PWA or the Core live gate.

Naming: the working name is TideGrid. The existing theme board says Tideline Grid, and the archived brand strategy records a possible naming conflict. Trademark clearance and a final naming decision remain open before any launch. See the [archive](docs/archive/README.md).

## Repository layout

| Path | Contents |
|---|---|
| [docs/v2](docs/v2/00-index.md) | Canonical planning package: strategy, scope, commercial model, architecture, roadmap, decision register, formation, hosting, native app factory, build execution plan, and pre-customer validation plan. |
| [docs/customer](docs/customer/tidegrid-validation-brief.md) | Customer-facing validation brief, internal interview guide, deck, and follow-up drafts. |
| [docs/v1](docs/v1/README.md) | Historical July 2026 design package: specification, ADRs, and diagrams. Read-only history. |
| [docs/archive](docs/archive/README.md) | Preserved source prompts, brand strategy, and theme board. Read-only history. |
| [prototypes/guest-flow](prototypes/guest-flow/README.md) | Throwaway guest workflow and operator concept prototype. Static HTML, CSS, and JavaScript with Node tests. |
| [database](database/README.md) and [api](api/openapi.yaml) | V1 PostgreSQL schema, acceptance tests, and OpenAPI contract. V1 artifacts, not a V2 implementation contract. |
| [research](research/source-register.md) | Primary-source register and interview notes. |
| [scripts](scripts/check-links.cjs) | Repository checks, currently the Markdown link and heading-anchor checker. |

## Prototype

The public demo is at [demo.tidegrid.us](https://demo.tidegrid.us). It simulates booking, payment, messages, and signatures; use fictional guest details. Cloudflare serves a managed `robots.txt` at HTTP 200 on this zone; that file is not in the repository.

Run it locally from the repository root, then open `http://127.0.0.1:4287`:

```sh
python3 -m http.server 4287 --bind 127.0.0.1 --directory prototypes/guest-flow
```

Run the automated checks with Node 22 or later:

```sh
npm test
npm run check
```

Deployment steps, the asset allowlist, and response headers are in the [prototype README](prototypes/guest-flow/README.md).

## Documentation

Start at the [V2 planning index](docs/v2/00-index.md). When documents conflict, the V2 decision register wins, then the other numbered V2 documents, then the V1 ADRs that V2 explicitly retains, then V1 design evidence, then source prompts and research notes. The commercial baseline, including prices, fees, and pilot terms, lives in the [commercial model](docs/v2/03-commercial-model.md). Agent roles, file ownership, and effort budgets live in the [build execution and agent plan](docs/v2/10-build-execution-and-agent-plan.md).
