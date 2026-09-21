# Link Shortener Demo

A small URL shortener, plus a workflow engine that walks a requirement through the software lifecycle
(requirements, design, build, test, docs, release) with approvals, retries, rollback and an audit trail.

This is a sample for the "agentic software engineering" interview assignment. No dependencies, no build step, no cloud.

## What's in it

| Part | Where | What it does |
| --- | --- | --- |
| Shortener service | `src/shortener/` | Create short links, custom aliases, expiry, redirects, click analytics, rate limiting |
| Workflow engine | `src/orchestrator/engine.js` | Dependency graph, gates, parallel branches, approvals, retry / fallback / rollback, safe-stop, replanning |
| Agents | `src/orchestrator/agents.js` | The workers each stage calls (rule-based stand-ins, see limitations) |
| Scenarios | `src/orchestrator/scenarios.js` | Greenfield, brownfield, ambiguous |
| Docs | `docs/` | Architecture write-up and OpenAPI spec |

## Setup

Needs Node 20 or newer. Nothing to install.

```bash
npm test                      # all tests (shortener + engine + scenarios)
npm start                     # shortener on http://localhost:3000
npm run scenario:greenfield   # or :brownfield / :ambiguous
```

Try the API:

```bash
curl -s -X POST localhost:3000/api/links -H 'content-type: application/json' \
  -d '{"url":"https://example.com/some/long/path","alias":"demo","ttlSeconds":3600}'
curl -i localhost:3000/demo
curl -s localhost:3000/api/links/demo/stats
```

Environment variables: `PORT` (3000), `BASE_URL`, `DATA_FILE` (`data/links.json`), `RATE_LIMIT` (60 per minute per client).

## The three scenarios

Each run prints a live event feed, then a result table and reliability metrics. Files land in `out/<scenario>/`
(`SUMMARY.md`, `DESIGN.md`, `RELEASE_NOTES.md`, `audit.jsonl`, `report.json`).

| Scenario | Requirement | What it shows |
| --- | --- | --- |
| `greenfield` | Full URL shortener spec | Clear input; decomposition into task waves; a docs failure that is retried and recovered (MTTR) |
| `brownfield` | Add a max-click limit to existing links | Codebase analysis finds impacted modules; the full security review fails so the fallback runs; output is a change plan for a human to apply |
| `ambiguous` | "Fast and secure, able to scale, expires soon" | Vague terms flagged; design is blocked until a human answers; a stakeholder then changes an answer and downstream stages are re-planned |

Extra flags:

```bash
node src/orchestrator/cli.js greenfield --reject-release   # human says no: safe-stop, docs rolled back, summary skipped
node src/orchestrator/cli.js ambiguous --interactive       # you answer the questions and approve at the prompt
```

## Testing approach

- Shortener: unit tests (validation, service with a fake clock, rate limiter, persistence) and HTTP integration tests against a real server on a random port.
- Engine: one test per control: ordering and parallel joins, lineage, retry bounds, fallback, rollback order, gates, approvals, policy violations, replan (including a run in flight), bad graphs, audit tamper detection, metrics.
- Scenarios: each one runs end to end; the ambiguous one also runs with no human answers to prove the gate holds. The real `test` stage runs the shortener suite in a child process; tests stub it out to stay quick.

## Limitations and trade-offs

- The agents are deterministic rule-based code, not language models. They have the same shape a model call would (inputs in, output plus decisions out), so swapping one in is local, but that hasn't been done here.
- Human approvals are scripted by default. `--interactive` makes them real.
- Brownfield produces a change plan; it does not edit code. That is deliberate (agents propose, humans apply), but it means that scenario does not change the shortener.
- Storage is one process with a JSON mirror written on every change. Fine for a demo, not for scale-out.
- Rate limiting is per process and keyed on socket address (no proxy headers are trusted).
- Rollback undoes files written to `out/`. It cannot undo external side effects, so the release stage only writes notes and deploys nothing.
- Failures are injected on purpose in the scenarios to exercise retry and fallback.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the engine works.
