# TideGrid V1 design package

**Status:** Historical V1 design package (July 2026). Superseded for current planning by [TideGrid V2](../v2/00-index.md).

This folder preserves the July 2026 departure-operations concept as design evidence. It does not define current scope, pricing, or implementation commitments. When documents conflict, the [V2 decision register](../v2/06-decision-register.md) decides which V1 decisions still apply.

## Contents

| Folder | What it holds |
|---|---|
| [spec](spec/00-index.md) | The V1 specification: 21 numbered sections, the [requirements traceability matrix](spec/requirements-traceability.md), and the [V1 pricing strategy](spec/pricing-strategy.md). |
| [adr](adr/README.md) | 20 architecture decision records accepted inside V1. |
| [diagrams](diagrams/README.md) | 15 Mermaid diagram sources. |

## Root-level V1 artifacts

The executable artifacts stay at the repository root.

- [PostgreSQL schema](../../database/schema.sql) and [database implementation guide](../../database/README.md)
- [Database acceptance tests](../../database/acceptance-tests.sql) and [concurrency race harness](../../database/concurrency-tests.sh)
- [OpenAPI 3.0 contract](../../api/openapi.yaml)

Do not treat the V1 schema or API as an implementation contract for V2.

## Source prompt

The prompt that produced this package is preserved verbatim in [docs/archive](../archive/README.md) as [TIDEGRID_PLATFORM_ARCHITECTURE_PROMPT.md](../archive/TIDEGRID_PLATFORM_ARCHITECTURE_PROMPT.md).
