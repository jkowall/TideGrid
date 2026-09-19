# TideGrid agent instructions

## Product status

- TideGrid is exploratory. Do not assume the owner has committed to building, launching, or funding it.
- Default to discovery, evidence gathering, and decision support.
- Treat implementation as authorized only when the owner explicitly asks for build work.

## Authority order

- Follow the [authority order](docs/v2/00-index.md#authority-and-historical-artifacts) in the V2 index. The [decision register](docs/v2/06-decision-register.md) wins every conflict; the other numbered V2 documents come next.
- Read the current repository artifacts before making product, commercial, or architecture claims.

## Repository rules

- `docs/v1` and `docs/archive` are read-only history. Never edit them to match V2; record the current decision in V2 and link back.
- `prototypes/guest-flow` is a throwaway demo, not production code. Do not treat its behavior as an implementation contract.
- Model and tool names belong only in [docs/v2/10-build-execution-and-agent-plan.md](docs/v2/10-build-execution-and-agent-plan.md). Elsewhere, say "the build execution and agent plan" and link to it.
- No customer data, credentials, or personal filing details in this repository. The owner keeps those in a private location outside the repo.

## Commands

Run from the repository root with Node 22 or later (`.nvmrc` pins 24).

```sh
npm test                          # prototype unit tests
npm run check                     # JavaScript syntax checks plus the Markdown link check
node scripts/check-links.cjs      # Markdown relative links and heading anchors only
python3 -m http.server 4287 --bind 127.0.0.1 --directory prototypes/guest-flow
npx --yes wrangler@4.125.0 deploy --config wrangler.prototype.jsonc --dry-run
```

Do not deploy the demo unless the owner asks. The [prototype README](prototypes/guest-flow/README.md) has the deploy steps.

## Writing rules

- No em dashes anywhere. Short sentences.
- Label proposed features as proposed. Keep the nonbinding, exploratory framing.
- Separate observed evidence (interviews, prototype sessions, primary sources) from hypotheses and proposed solutions.
