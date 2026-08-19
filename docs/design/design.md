# Proposed YAML schema

A candidate schema satisfying every item in [requirements.md](./requirements.md) —
both the core list and the additional candidates — built from the patterns
surveyed in [patterns.md](./patterns.md). This is a proposal to react to, not
a committed spec.

## Design decisions

requirements.md ended with three open questions. This schema answers them,
because a concrete design has to commit to something:

- **Composability**: yes. A step can delegate to another workflow file via
  `uses:`, mirroring Open Agent Spec's `spec:`/`task:` delegation, Conductor's
  `type: workflow`, and GitHub Actions' reusable workflows.

- **State tracking**: both, reconciled into one mechanism. The run-state file
  (`state.path`) is a plain YAML document of named step outputs — machine-
  readable like Open Agent Spec/Conductor's model — but it's also just a
  file on disk a human can open and read mid-run, which is the property
  `ohitslaurence/agent-loop`'s plan file has that a session store doesn't.
  It isn't a checklist a human edits to steer the run, though — see the
  handoff/gate mechanisms below for the ways a human or agent *can* change
  course mid-run.

- **Stop conditions**: split into three distinct constructs, not one generic
  mechanism. See "Three iteration semantics, three constructs" below — this
  was the single biggest finding from the pattern research and collapsing it
  back into one field would lose the distinction that made it worth calling
  out.

- **Sequential pipeline, not a DAG** (revised 2026-07-30, after the rest of
  this doc was first written): `steps` runs in document order — the order
  steps are declared in the YAML — with no dependency field and no
  concurrent execution. The original design below called for `needs:` edges
  and a `strategy.matrix` construct for concurrent branches, matching the
  "YAML DAG" and "Parallel branches" requirements. Both were removed:
  real usage never needed independent branches, and the actual execution
  backend for agent steps (`genie`, routed through a local Ollama daemon in
  this project's setup) serializes model calls regardless of how many `wish`
  tries to run at once — so concurrent steps would only add DAG-validation
  complexity (cycle detection, topological sort) without buying real
  wall-clock benefit. See "Retry cycles without a dependency graph" below
  for what this means for the bounded-loop-back pattern, and
  [requirements.md](./requirements.md)'s revision note for the full
  rationale. Mentions of `needs:`, DAG edges, and `strategy.matrix` elsewhere
  in this document are the *original* design and are kept for history, not
  as the current target shape — the "Field reference" and rationale
  sections below have been updated to reflect the pipeline model; the full
  example has not been rewritten line-by-line beyond removing `needs:`.

## Requirements → schema mapping

| Requirement | Schema construct |
|---|---|
| YAML sequential pipeline | `steps` (ordered mapping; document order is execution order — see design decisions above) |
| Human gates | `steps.<id>.type: human_gate` |
| ~~Parallel branches~~ | Removed — see design decisions above |
| Mix of agentic/deterministic steps | `steps.<id>.type: agent \| script \| human_gate \| workflow` |
| Agent handoffs | `agents[].handoff`, referenced from within an agentic step |
| Stop conditions, iteration limits | `limits:` (workflow), `steps.<id>.retry` (cycle), `steps.<id>.max_steps`/`until` (single-step) |
| State and progress tracking | `state.path` — resumable, human-readable run-state file |
| Session transcripts | `transcripts:` |
| Typed, addressable step outputs | `steps.<id>.outputs` schema, referenced as `{{ steps.<id>.outputs.field }}` |
| Tools/model/identity as independent axes | `tools:`, `agents:` registries, referenced separately from a step |
| Conditional/deterministic routing | `steps.<id>.if` |
| Iteration semantics | `retry.rerun` (whole-cycle repeat) / `max_steps`+`until` (single-step) — see below |
| Resource caps beyond iteration count | `limits.timeout`, `limits.budget_usd` |
| Retry policy separate from stop conditions | `steps.<id>.retry` |
| Composable/reusable workflows | `steps.<id>.uses` + `with` |
| Context propagation mode | `context.mode` |
| Observability hooks | `hooks:` |

## Full example

```yaml
wish: "1"
name: fix-and-verify
description: >
  Investigate a failing test suite, fix it, get human sign-off, then
  fan out release notes across affected packages.

on:
  manual: {}
  schedule: "0 6 * * 1-5"

limits:                        # workflow-wide stop conditions / resource caps
  max_turns: 200
  timeout: 45m
  budget_usd: 10.00

context:
  mode: accumulate              # accumulate | snapshot | minimal

state:
  path: .loop/runs/{{ run.id }}/state.yaml

transcripts:
  path: .loop/runs/{{ run.id }}/transcripts/{{ step.id }}.jsonl
  save: agentic                 # agentic | all | none

input:
  repo:
    type: string
    required: true

tools:
  - name: shell
    type: native
  - name: github
    type: mcp
    server: github-mcp

agents:
  - name: triager
    model: technical-lead
    system_prompt: You diagnose failing test suites.
    tools: [shell]
    handoff: [fixer]
  - name: fixer
    model: computer-programmer
    system_prompt: You fix bugs and re-run tests until green.
    tools: [shell]

steps:
  test:
    type: script
    run: npm test -- --json
    outputs:
      failures: { type: array }

  diagnose:
    if: "{{ steps.test.outputs.failures | length > 0 }}"
    type: agent
    agent: triager
    prompt: |
      Diagnose these failures and hand off to `fixer` once you have a plan:
      {{ steps.test.outputs.failures }}
    outputs:
      root_cause: { type: string }
      affected_packages: { type: array }

  implement:
    type: agent
    agent: fixer
    prompt: "Fix the root cause: {{ steps.diagnose.outputs.root_cause }}"
    max_steps: 20                                        # single-step iteration cap
    until: "{{ steps.implement.outputs.tests_pass == true }}"   # single-step stop condition
    outputs:
      tests_pass: { type: boolean }
      diff_summary: { type: string }

  verify:
    type: script
    run: npm test -- --json
    outputs:
      passed: { type: boolean }
    retry:
      until: "{{ steps.verify.outputs.passed == true }}"
      max_attempts: 3
      rerun: [implement, verify]      # bounded loop-back — see rationale below

  approve:
    if: "{{ steps.verify.outputs.passed == true }}"
    type: human_gate
    options:
      - name: approve
      - name: reject

  release_notes:
    if: "{{ steps.approve.output.choice == 'approve' }}"
    strategy:
      matrix:
        package: "{{ steps.diagnose.outputs.affected_packages }}"
      max_parallel: 5
      on_error: continue
    type: agent
    agent: fixer
    prompt: "Write release notes for {{ matrix.package }}"
    outputs:
      notes: { type: string }

  publish:
    uses: ./workflows/publish.yaml
    with:
      notes: "{{ steps.release_notes.outputs }}"

hooks:
  on_start: "{{ log('run ' + run.id + ' started') }}"
  on_step_complete: "{{ log(step.id + ' -> ' + step.status) }}"
  on_error: "{{ notify(run.id, error.message) }}"
```

## Field reference

### Top-level workflow fields

| Field | Purpose | Inspiration |
|---|---|---|
| `wish` | Schema version, optional (defaults to `"1"`) | Self-named, like OpenAPI's `openapi:` field and Kubernetes' `apiVersion:` — not bare `version:`, which risks reading as "version of this particular wish" rather than "version of the schema dialect" |
| `name`, `description` | Identity | All sources |
| `on` | Trigger (manual, schedule, …) | GitHub Actions `on:` |
| `limits` | Workflow-wide turn cap, wall-clock timeout, cost cap | Conductor `limits:` |
| `context.mode` | How much prior step output a step sees (`accumulate`/`snapshot`/`minimal`) | Conductor `context_mode` |
| `state.path` | Where the resumable, human-readable run-state file is written | Reconciles Open Agent Spec/Conductor's named-output model with `ohitslaurence/agent-loop`'s plan file |
| `transcripts` | Where/whether full conversation history is persisted per step | Session-transcript requirement; no direct source analogue |
| `input` | Typed workflow inputs | Open Agent Spec `input:` |
| `tools` | Workflow-level tool registry (native, MCP, script) | Open Agent Spec's three tool varieties; Conductor's `tools:` list |
| `agents` | Reusable agent definitions: model, system prompt, default tools, allowed handoff targets | Taskflow's personalities |
| `steps` | The pipeline itself — an ordered mapping, run in document order | GitHub Actions' job-level `steps:` list (always sequential, no dependency field) — a deliberate scoping-down from a full DAG; see design decisions above |
| `hooks` | Lifecycle callbacks | Conductor `hooks:` |

### Step fields common to every type

| Field | Purpose |
|---|---|
| `if` | Deterministic, non-LLM route condition (first-match-wins evaluation, Conductor-style) |
| `outputs` | Typed output schema, addressable as `{{ steps.<id>.outputs.field }}` |
| `retry` | Bounded re-execution of this step (and optionally named upstream steps) on failure — see below |

### Step types

- **`type: agent`** — an LLM-backed step. `agent:` references a name from
  the top-level `agents:` registry (model, prompt, default tools all live
  there — kept separate so they can be swapped independently, per the
  "tools/model/identity as independent axes" requirement). `max_steps` and
  `until` bound the agent's *own* internal iteration on this one step.
  Execution shells out to [`genie`](https://github.com/kieranpotts/genie), not
  the Claude Agent SDK — which means `model:` is one of *its* fixed roles
  (`computer-programmer`, `technical-lead`, `technical-writer`,
  `security-analyst`), not an arbitrary model ID, and `tools:` has no home in
  genie's per-invocation CLI at all (tool access is baked into its hardened
  image at build time). The first implementation only runs a single genie
  call per step — `until`/`max_steps` need genie session continuity that
  doesn't exist, so a step declaring either is refused rather than silently
  run once.
- **`type: script`** — a deterministic step: a shell command (or HTTP call,
  or any non-LLM action) whose stdout is parsed against `outputs`. Cf.
  Taskflow's `run:` field.
- **`type: human_gate`** — pauses the run; `options` lists the choices a
  human can make, addressable downstream as `{{ steps.<id>.output.choice }}`.
  Cf. Conductor's `human_gate`; conceptually the same as GitHub Actions'
  environment protection rules (required reviewers on an `environment:`).
- **`type: workflow`** — delegates to another Loop YAML file via `uses:`,
  passing `with:` as that workflow's `input:`. Cf. Open Agent Spec's
  `spec:`/`task:` delegation, Conductor's `type: workflow`, GitHub Actions
  reusable workflows.

### Agent handoffs

A step's `agent:` is its *starting* agent identity. That agent can hand off
mid-step to any agent named in its `handoff:` list (declared once, on the
agent definition, not per-step):

```yaml
agents:
  - name: triager
    handoff: [fixer]           # triager may hand off to fixer
  - name: fixer
```

A handoff happens *within* one step — it does not create a new pipeline
entry. This is deliberate: a handoff is "who should keep working on this,"
not "should this continue" (that's `human_gate`) and not "which step runs
next" (that's `if` — see design decisions above on why there's no `needs`
to route around).

## Design rationale

### Retry cycles without a dependency graph

patterns.md's research found a real, common pattern — plan → implement →
verify → (back to implement if verification fails) — that looks like it
needs a cycle. Conductor gets this by having non-DAG `routes:` that can
point back to an earlier agent. The original (DAG) version of this schema
kept `steps`/`needs` strictly acyclic instead, and expressed the retry-back
behavior as a bounded, explicit unrolling — a decision that turns out not to
depend on there being a DAG at all: a plain sequential pipeline has no way
to declare a back-edge in the first place (there's no dependency field to
point backwards with), so it's trivially free of this problem, and the same
`retry`/`rerun` construct still works unchanged:

```yaml
retry:
  until: "{{ steps.verify.outputs.passed == true }}"
  max_attempts: 3
  rerun: [implement, verify]
```

`rerun` names the steps to re-execute — an explicit re-run instruction, not a
graph edge of any kind. The runtime just knows to loop `[implement, verify]`
up to `max_attempts` times. This is the schema's answer to the whole-cycle
case of "iteration semantics" below.

### Iteration semantics

patterns.md found (at least) three things that get called "loop"; this
schema covers two of them (the third, mapping a step over a list of inputs
in parallel — Conductor's `for_each` / this schema's original
`strategy.matrix` — was removed along with parallel branches generally; see
design decisions above):

| Semantics | Construct | Precedent |
|---|---|---|
| Repeat a whole plan→act→verify cycle until a condition holds | `retry.rerun` | Conductor's conditional routing (adapted to a pipeline with no back-edges — see above) |
| Let one step iterate internally until it self-reports done | `max_steps` + `until` | Taskflow's `repeat_prompt` + `max_steps` |

Keeping these as two separate fields (rather than one generic `loop:` block)
means the state and stop-condition concerns for each stay legible: cycle
retry needs `max_attempts`/`rerun`, internal iteration needs
`max_steps`/`until` — neither set of options makes sense on the other.

### Handoff vs. gate vs. routing

Three different "what happens next" mechanisms exist in this schema on
purpose, because patterns.md found they answer three different questions:

- `if:` — **which step runs next** (a deterministic, non-LLM decision)
- `type: human_gate` — **should this continue at all** (a human decision)
- `agents[].handoff` — **which agent identity keeps working on this step**
  (an in-step delegation decision, made by the agent itself)

Collapsing these into one "pause and reassign" primitive would blur a
routing decision, an approval decision, and a delegation decision that are
genuinely independent in the sources this schema draws from.

## Sources

- [Open Agent Spec](https://www.openagentspec.dev/) /
  [GitHub](https://github.com/prime-vector/open-agent-spec)
- [Microsoft Conductor](https://github.com/microsoft/conductor) /
  [workflow-syntax.md](https://github.com/microsoft/conductor/blob/main/docs/workflow-syntax.md) /
  [parallel-execution.md](https://github.com/microsoft/conductor/blob/main/docs/parallel-execution.md)
- [GitHubSecurityLab/seclab-taskflow-agent](https://github.com/GitHubSecurityLab/seclab-taskflow-agent)
- [`ohitslaurence/agent-loop`](https://github.com/ohitslaurence/agent-loop)
- [`cobusgreyling/loop-engineering`](https://github.com/cobusgreyling/loop-engineering/tree/main)
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)

## Minimal MVP increment

The full schema above is the target shape, not the starting point. A useful
first cut needs enough to be a real loop tool — an ordered pipeline of
steps, at least one way to stop, and state that survives a crash — without
the machinery that only pays off once there's more than one workflow to
reuse or more than one person involved in a run.

**MVP field set:**

- `wish` (optional, defaults to `"1"`), `name` — identity
- `steps` — an ordered mapping run in document order, no dependency field
  and no `if:` (branching deferred; see design decisions above for why
  there's no `needs:` at all, at MVP or otherwise)
- `steps.<id>.type: agent | script` — only these two step types
- `steps.<id>.model` / `prompt` / `tools` — inlined directly on the step; no
  top-level `agents:`/`tools:` registries yet (those only pay for themselves
  once handoff or cross-step reuse exists)
- `steps.<id>.outputs` — typed, addressable outputs; the pipeline can't pass
  data between steps without this, so it isn't optional even at MVP
- `steps.<id>.max_steps` / `until` — the one stop-condition construct that's
  truly load-bearing even for a single step (an agentic step that never stops
  is the core failure mode a "loop" tool exists to prevent)
- `limits` — workflow-wide `max_turns`/`timeout`/`budget_usd`, as a blanket
  safety net behind the per-step one
- `state.path` — resumable run-state file

```yaml
wish: "1"
name: fix-and-verify

limits:
  max_turns: 200
  timeout: 45m
  budget_usd: 10.00

state:
  path: .loop/runs/{{ run.id }}/state.yaml

steps:
  test:
    type: script
    run: npm test -- --json
    outputs:
      failures: { type: array }

  implement:
    type: agent
    model: computer-programmer
    tools: [shell]
    prompt: "Fix the failures: {{ steps.test.outputs.failures }}"
    max_steps: 20
    until: "{{ steps.implement.outputs.tests_pass == true }}"
    outputs:
      tests_pass: { type: boolean }
```

**Deferred, and why:**

| Construct | Deferred because |
|---|---|
| `if:` conditional routing | Branching only matters once a workflow has more than one possible path; a straight-line pipeline covers the first real use cases |
| `type: human_gate` | Needs an approval/notification surface (who gets asked, how) that doesn't exist yet — infrastructure, not schema |
| `strategy.matrix` (parallel fan-out) | Removed, not deferred — see "Sequential pipeline, not a DAG" in design decisions above |
| `retry`/`rerun` (cycle retry) | The bounded-loop-back semantics are the most novel/riskiest part of the design (see rationale above) — worth proving out the simple case first |
| `agents:`/`tools:` registries, `handoff` | Only pay off with reuse across steps or multiple agent identities in one run; a single inline agent per step is enough until then |
| `type: workflow` (`uses`/`with`) | Composability matters once there's more than one workflow file to compose |
| `context.mode` | `accumulate` is a reasonable fixed default until context-cost becomes an actual problem |
| `hooks` | Observability beyond the state file and transcripts can wait until something is consuming those events |
| `transcripts:` (as configurable YAML) | Ship with transcripts always-on, unconfigurable, at a fixed path — configurability isn't needed until there's a reason to turn them off |
| `on:` triggers | A CLI invocation (`wish <name>`) is sufficient before scheduling/webhooks are needed |

**Suggested sequencing** after MVP: `if:` + `type: human_gate` next (the
two cheapest, most-requested additions), then `retry`/`rerun`, with
registries/`handoff`/composability/`hooks` last since they're the parts of
the schema this design is least battle-tested on.
