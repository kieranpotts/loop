# Project state — for resuming with an AI assistant

This file exists so a fresh AI session (Claude Code or similar) can pick up
this project without losing the architecture decisions and rationale behind
them — written 2026-07-30, after the retry/rerun increment landed. If you're
an AI reading this cold: read this whole file before touching code. If you're
Kieran: this is the thing to point a new session at if its memory of this
project has been lost (e.g. after a working-directory change).

The authoritative design docs are [docs/design/patterns.md](./docs/design/patterns.md),
[docs/design/requirements.md](./docs/design/requirements.md), and
[docs/design/design.md](./docs/design/design.md) — this file summarizes and
cross-references them, but doesn't replace them. When this file and the
design docs disagree, the design docs win (this file may lag).

## What this is

`wish` is a CLI (in this repo, `kieranpotts/loop`) that runs YAML workflow
files — "wishes" — stored at `.agents/wishes/<name>.yaml`, invoked as
`wish <name>`. A wish is an ordered pipeline of `script` (deterministic
shell command) and `agent` (single LLM call via `genie`) steps, with
typed outputs threaded between them, workflow-wide turn/timeout limits, a
resumable state file, and now, failure-triggered retry with bounded
loop-back.

## Architecture decisions, in build order

- **Language: TypeScript**, not Go (started in Go, switched early). Reason:
  consistency with the author's other agent-harness projects (`genie`, `pi`),
  which are also TS. Runs directly via Node's native TypeScript support
  (`node src/main.ts`, no build/tsc-emit step) — `tsconfig.json` is
  type-checking only (`noEmit: true`).
- **Install**: `package.json`'s `"bin"` field + `run/install` running
  `npm install && npm link`. Deliberately idiomatic npm, not a custom
  installer.
- **Tooling**: mirrors `genie`/`pi` — `eslint.config.js` (neostandard,
  `eslint@^9` pinned since neostandard doesn't support v10 yet),
  `run/{check,lint,fix,typecheck,test}`, Node's built-in test runner
  (`node --test`, no test framework dependency).
- **Dependencies**: zero runtime dependencies except `yaml` (Node has no
  built-in YAML parser). Schema validation is hand-rolled TypeScript, not
  `zod`/`ajv` — matches `genie`/`pi`'s philosophy.
- **Schema is MVP-only**, not the full schema `design.md` proposes. See
  design.md's "Minimal MVP increment" section for the deferred-and-why list:
  `if:` conditional routing, `type: human_gate`, `agents:`/`tools:`
  registries + `handoff`, `type: workflow` composability, `context.mode`,
  `hooks`, configurable `transcripts:`, `on:` triggers. None of these are
  built yet.

## `steps` is a sequential pipeline, not a DAG — closed decision

This is the biggest design pivot so far and **should not be re-proposed**
unless the user raises it again themselves. Originally `steps` had
`needs:` edges (a real DAG, matching `requirements.md`'s original "YAML
DAG" + "Parallel branches" requirements). Both were removed:

- Investigated whether concurrent step execution was worth building, given
  `genie` as the agent backend. Found `genie`'s own container/session/proxy
  plumbing is safe for concurrency (single persistent Pi container,
  `docker compose exec` per call, random per-invocation session IDs, async
  LiteLLM proxy) — but the user's real bottleneck is **Ollama itself**
  serializing generations per loaded model (no `OLLAMA_NUM_PARALLEL`
  configured; raising it trades memory for throughput, not free).
- Given that, and that the user doesn't consider concurrent steps a real
  use case for their own workflows ("keep it simple"), parallel execution
  was ruled out entirely — and once there's no concurrency, a dependency
  graph buys nothing over a plain ordered list. `needs:` was removed too.

What actually changed: `steps` is executed in **document order** — the
order keys are declared in the YAML — via `Object.keys(wish.steps)` in
`src/exec.ts`. `src/dag.ts` (Kahn's-algorithm topological sort + DFS cycle
detection) and its tests were deleted entirely, since nothing needs them
now. `docs/design/requirements.md` and `docs/design/design.md` were both
revised to reflect this (see their own "revision" notes, dated 2026-07-30).

## Execution engine (`src/exec.ts`, `src/schema.ts`)

- **`type: script`**: runs the (templated) `run:` command via
  `spawnSync(command, { shell: true, maxBuffer: 64MB })`. A step with
  declared `outputs` must print one JSON object to stdout matching that
  schema; a step with none streams stdout straight to the terminal.
- **`type: agent`**: shells out to [`genie`](https://github.com/kieranpotts/genie)
  — NOT the Claude Agent SDK, NOT the `claude` CLI. Single-shot only: one
  `genie -p <prompt> -m <model>` call per step (`spawnSync` with an argv
  array, no `shell: true`, since prompts contain templated/untrusted
  content). genie's actual interface, learned by reading its source (not
  guessed), and confirmed against a **real** genie + Ollama setup, not just
  a fake test fixture:
  - `-m`/`model:` is a small fixed role enum — `computer-programmer`
    (default), `technical-lead`, `technical-writer`, `security-analyst` —
    not a free-form model ID. `wish` does NOT validate this itself; an
    invalid role is left to genie's own `resolve_model`, which fails closed.
    Don't add an enum check into `schema.ts` — that would duplicate genie's
    own source of truth and drift from it.
  - `--json` switches genie into a structured event stream, one JSON object
    per line. The actual reply is the **last** `message_end` event with
    `role: "assistant"`; its `content` array must be filtered to
    `type: "text"` parts (ignoring `type: "thinking"` parts) and
    concatenated — see `extractAssistantText()` in `src/exec.ts`.
  - genie has no session/resume flag. A step declaring `until`/`max_steps`
    (internal iteration) is refused up front rather than silently run once.
    So is a step declaring a non-empty `tools` list — genie bakes tool
    access into its own hardened image at build time, no per-invocation
    flag for it.
  - `wish` appends its own instruction to the prompt when a step declares
    `outputs` (`buildOutputInstruction()`), since genie has no native
    structured-output contract to lean on.
- **`state.path`**: a run id (`crypto.randomUUID()`) is generated once per
  run; if `state:` is set, a human-readable YAML file is written before any
  step runs (all `pending`) and rewritten after **every** step execution
  (success with outputs, or failed with its error) — including intermediate
  steps touched during a retry, not just the top-level step. Parent
  directories auto-created.
- **`limits.max_turns`/`limits.timeout` are enforced**; `limits.budget_usd`
  is validated but not enforced (needs token-usage extraction from genie's
  `--json` stream plus a per-role pricing table — deferred, separable
  work). One executed step (script or single-shot agent call, including
  retried re-executions) = one turn. `timeout` is a wall-clock budget for
  the *whole run*: each step gets the *remaining* budget as its own
  `spawnSync` timeout, so a hanging step gets killed via `SIGTERM` once the
  run's clock runs out.
- **`retry`** (`steps.<id>.retry: { max_attempts, rerun }`) — the latest
  increment. Trigger is **ordinary step failure** (nonzero exit, thrown
  error, `outputs` schema mismatch) — deliberately not a boolean `until:`
  expression (that alternative was considered and explicitly rejected via
  AskUserQuestion, since it would've needed a mini expression evaluator on
  top of the current string-interpolation-only `substitute()`, and the
  user's actual use case — a script step deterministically checking an
  agent's output — just needs the check to exit nonzero when the
  requirement isn't met, the same idiom as a CI step). Mechanics:
  - `runWish` has an internal `executeStep(id)` closure doing turn/timeout
    bookkeeping + dispatch + context/state update, returning either a
    normal `StepResult` or `{ ok: false, error, fatal: true }` for a
    `limits` cap reached before the step could run.
  - `fatal` is the key distinction: a `limits` cap is a run-level abort,
    never retried, even mid-retry-attempt (it still aborts the whole run
    immediately rather than counting as "this attempt failed").
  - On a retryable failure, if the step declares `retry`, loop
    `attempt = 2..max_attempts` (the initial failed run is attempt 1),
    each time re-executing every id in `retry.rerun` **in order**, breaking
    out of that inner sequence the moment any of them fails (so an earlier
    step failing during a retry means later ones in the list aren't
    reached that attempt). The whole retry ends the moment one full
    `rerun` pass succeeds.
  - Schema validation requires every `rerun` entry to be at or before the
    declaring step's own position in document order — retry can only go
    back, never jump ahead, since `steps` has no dependency graph to check
    against (a `Map<string, number>` of step id → index is built once in
    `validateWish` for this).
  - Confirmed via unit tests AND a real end-to-end run through the actual
    `wish` CLI: one run recovering after a single retry, one exhausting
    `max_attempts: 3` and reporting the genuine last-attempt error.

## Known gotchas already hit and fixed

- **Symlink/`import.meta.url` mismatch**: the installed `wish` command is a
  symlink via `npm link`. Node resolves symlinks for `import.meta.url` but
  NOT for `process.argv[1]`, so the entry-point guard in `src/main.ts` must
  compare against `realpathSync(process.argv[1])`, not a plain `resolve()`
  — a naive version silently broke the installed binary (no error, no
  output, exit 0, `main()` never ran).
- **`OLLAMA_HOST` needs a URL scheme** — a real bug in the `genie` repo
  (`src/infrastructure/.env.example` had `127.0.0.1:11434`, no `http://`),
  which `litellm.config.yaml`'s `api_base` passes straight through with no
  normalization, causing instant `aiohttp.InvalidUrlClientError` wrapped
  into a misleading generic `APIConnectionError`. Genie's own bash-side
  `check_ollama()` health check tolerates the bare form, but that
  normalization never reaches the actual proxy config. Fixed in both
  `~/.config/genie/env` (local) and the `genie` repo's `.env.example`
  (patched upstream, per explicit instruction to fix both).
- **`spawnSync ... ENOBUFS`** — Node's `spawnSync` defaults to a 1MB
  `maxBuffer`; genie's `--json` stream emits one event per token delta
  (including "thinking" content), easily exceeding that on a real prompt.
  Fixed with `maxBuffer: 64 * 1024 * 1024` on both script- and agent-step
  `spawnSync` calls in `src/exec.ts`.
  - Neither of the genie-related bugs above was caught by the automated
    test suite (which uses a fake `genie` fixture on PATH) — both only
    surfaced when actually running against real genie + Ollama
    infrastructure. Worth remembering: fake-fixture tests validate `wish`'s
    own logic, not real infrastructure's actual output volume/shape/config.

## Test coverage

60/60 tests pass as of the retry increment, across `test/main.test.ts`,
`test/schema.test.ts`, `test/exec.test.ts` (no `test/dag.test.ts` — deleted
along with `src/dag.ts` when the DAG was removed). Run `./run/check` for
lint + typecheck + test in one shot.

## Not built yet (known, deliberately deferred)

From `design.md`'s full schema, still out of scope: `if:` conditional
routing, `type: human_gate`, `agents:`/`tools:` registries + `handoff`,
`type: workflow` composability (`uses`/`with`), `context.mode`,
configurable `transcripts:` (currently no transcripts at all — genie's own
session storage is the only record), `hooks`, `on:` triggers,
`limits.budget_usd` enforcement. Multi-turn/iterating agent steps
(`until`/`max_steps` on a `type: agent` step) also stay refused — genie has
no session/resume flag to build that on top of yet.

**Suggested sequencing** (from design.md, still current): `if:` +
`type: human_gate` next (cheapest, most-requested), then whatever's left of
retry policy refinement, with registries/`handoff`/composability/`hooks`
last since they're the least battle-tested part of the design. This isn't
a commitment — ask the user what they want next rather than assuming this
order.
