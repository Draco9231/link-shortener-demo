# Architecture

## Big picture

```
  requirement
      |
      v
 +--------------+     +-----------+
 | requirements |---->| decompose |----+
 |  (approval)  |     +-----------+    |      +--------+     +-----------+
 +--------------+---->+-----------+    +----->| design |---->| implement |
        |             | codebase  |----+      +--------+     +-----+-----+
        |             | (brownf.) |                                 |
        +-------------+-----------+           +---------------------+--------------------+
                                              v                     v                    v
                                          +--------+          +----------+          +------+
                                          |  test  |          | security |          | docs |
                                          +---+----+          +----+-----+          +--+---+
                                              +----------+---------+-------------------+
                                                         v
                                                   +-----------+     +-----------------+     +---------+
                                                   | readiness |---->| release         |---->| summary |
                                                   | (join)    |     | (human approval)|     +---------+
                                                   +-----------+     +-----------------+
```

Each box is a stage. Arrows are dependencies. A stage starts only when everything it depends on is done, so
`decompose` and `codebase` run side by side, as do `test`, `security` and `docs`, and `readiness` waits for all three.

## The engine (`src/orchestrator/engine.js`)

A `Workflow` is a set of stages plus policies, an approver and a shared context.

**Scheduling.** The run loop looks for pending stages whose dependencies are all done, starts them (up to `maxParallel`),
and waits for any one to finish before looking again. The graph is checked at construction: unknown dependencies,
duplicate ids and cycles are rejected, and a stage marked `highImpact` must declare an approval checkpoint.

**Gates.** `entryGate` runs before a stage starts, `exitGate` after the agent returns. Each returns a reason string
if it fails. An entry-gate failure is fatal. An exit-gate failure counts as a failed attempt and can be retried.
Example: `design` will not start while any ambiguity is unanswered; `release` will not start unless readiness passed.

**Human approval.** A stage can ask for approval `before` it runs (release) or `after` (requirements). The approver can
approve, reject, or approve with an amendment (the requirements reviewer answers the open questions this way). With no
approver configured the answer is no. Every request and decision goes in the audit log.

**Failure handling.**
1. Retry the primary agent, up to `retries` extra times.
2. Then try the stage's `fallback` agent once, if it has one.
3. If that fails, or a gate or policy fails fatally, or a human says no: safe-stop. Nothing new starts, stages that never ran
   are marked `skipped`, and finished stages that have a `rollback` are undone, newest first.

**Policies (`policies.js`).** Run on every agent output. `no-secrets` blocks credential-looking output.
`write-scope` blocks writes outside the run's output folder. A violation is fatal and is never retried.

**Replanning.** `replan(stageId, patch, reason)` changes a finished stage's output, bumps its version, and resets every
stage downstream of it. A downstream stage that was mid-run notices its epoch changed when it finishes and throws its
result away instead of applying it. The ambiguous scenario uses this when a stakeholder changes a target after seeing the design.

**Lineage.** When a stage starts it records which version of each upstream output it consumed. After a replan you can see
exactly which outputs were built on old inputs. Agents also return `decisions` (what and why); each is written to the audit log.

**Audit and metrics.** Every event goes into an append-only log where each entry holds the hash of the previous one, so
edits or deletions are detectable (`verify()`). Metrics come from the run itself: success rate, attempts, retries, fallbacks,
rollbacks, replans, approvals, policy violations, MTTR (first failure to eventual success, per stage) and end-to-end time.

## The service (`src/shortener/`)

`server.js` (routes) -> `service.js` (rules) -> `store.js` (memory + JSON mirror), with `validate.js`, `codes.js` and `ratelimit.js` alongside.
The API is in [openapi.yaml](openapi.yaml).

Key decisions:
- **302, not 301**, so browsers do not cache the redirect and every click is counted.
- **Expired links answer 410** and are not counted; unknown codes answer 404.
- **URL rules at creation time:** http(s) only, max 2048 characters, no embedded credentials, no loopback or private hosts.
- **Random 7-character codes** with bounded collision retries; custom aliases get a 409 on clashes and a reserved-word list.
- **Body size cap** (10 KB) and a **per-client rate limit** returning 429 with `Retry-After`.
- **Atomic persistence:** write to a temp file, then rename.

## Risks and how they are handled

| Risk | Handling |
| --- | --- |
| Service used to redirect people to internal hosts | Creation-time host checks, tested directly and probed by the security agent |
| Agent output leaks a secret or writes somewhere it should not | Policies on every output, fatal on violation |
| A bad approval or a partial run leaves junk behind | Safe-stop plus ordered rollback |
| Upstream requirement changes after work has started | Replan with versioned lineage, stale runs discarded |
| Someone edits the audit trail | Hash chain, verified in the report |
| Reduced-coverage fallback hides a gap | Fallback use is counted and named in the audit log and summary |
