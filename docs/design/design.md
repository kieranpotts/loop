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

## Requirements → schema mapping

| Requirement | Schema construct |
|---|---|
| YAML DAG | `steps.<id>.needs` (acyclic; see rationale below) |
| Human gates | `steps.<id>.type: human_gate` |
| Parallel branches | `steps.<id>.strategy.matrix` (also covers per-item iteration) |
| Mix of agentic/deterministic steps | `steps.<id>.type: agent \| script \| human_gate \| workflow` |
| Agent handoffs | `agents[].handoff`, referenced from within an agentic step |
| Stop conditions, iteration limits | `limits:` (workflow), `steps.<id>.retry` (cycle), `steps.<id>.max_steps`/`until` (single-step) |
| State and progress tracking | `state.path` — resumable, human-readable run-state file |
| Session transcripts | `transcripts:` |
| Typed, addressable step outputs | `steps.<id>.outputs` schema, referenced as `{{ steps.<id>.outputs.field }}` |
| Tools/model/identity as independent axes | `tools:`, `agents:` registries, referenced separately from a step |
| Conditional/deterministic routing | `steps.<id>.if` |
| Three iteration semantics | `strategy.matrix` / `retry.rerun` / `max_steps`+`until` (see below) |
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
    model: claude-sonnet-5
    system_prompt: You diagnose failing test suites.
    tools: [shell]
    handoff: [fixer]
  - name: fixer
    model: claude-sonnet-5
    system_prompt: You fix bugs and re-run tests until green.
    tools: [shell]

steps:
  test:
    type: script
    run: npm test -- --json
    outputs:
      failures: { type: array }

  diagnose:
    needs: [test]
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
    needs: [diagnose]
    type: agent
    agent: fixer
    prompt: "Fix the root cause: {{ steps.diagnose.outputs.root_cause }}"
    max_steps: 20                                        # single-step iteration cap
    until: "{{ steps.implement.outputs.tests_pass == true }}"   # single-step stop condition
    outputs:
      tests_pass: { type: boolean }
      diff_summary: { type: string }

  verify:
    needs: [implement]
    type: script
    run: npm test -- --json
    outputs:
      passed: { type: boolean }
    retry:
      until: "{{ steps.verify.outputs.passed == true }}"
      max_attempts: 3
      rerun: [implement, verify]      # bounded loop-back — see rationale below

  approve:
    needs: [verify]
    if: "{{ steps.verify.outputs.passed == true }}"
    type: human_gate
    options:
      - name: approve
      - name: reject

  release_notes:
    needs: [approve]
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
    needs: [release_notes]
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
| `steps` | The DAG itself | GitHub Actions `jobs:` + Open Agent Spec `depends_on` |
| `hooks` | Lifecycle callbacks | Conductor `hooks:` |

### Step fields common to every type

| Field | Purpose |
|---|---|
| `needs` | Upstream step IDs — the DAG edges |
| `if` | Deterministic, non-LLM route condition (first-match-wins evaluation, Conductor-style) |
| `outputs` | Typed output schema, addressable as `{{ steps.<id>.outputs.field }}` |
| `retry` | Bounded re-execution of this step (and optionally named upstream steps) on failure — see below |

### Step types

- **`type: agent`** — an LLM-backed step. `agent:` references a name from
  the top-level `agents:` registry (model, prompt, default tools all live
  there — kept separate so they can be swapped independently, per the
  "tools/model/identity as independent axes" requirement). `max_steps` and
  `until` bound the agent's *own* internal iteration on this one step.
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

A handoff happens *within* one step — it does not create a new DAG node. This
is deliberate: a handoff is "who should keep working on this," not "should
this continue" (that's `human_gate`) and not "which step runs next" (that's
`needs`/`if`).

## Design rationale

### DAG acyclicity vs. the "retry cycle" pattern

Requirement #1 asks for a DAG, which by definition has no cycles. But
patterns.md's research found a real, common pattern — plan → implement →
verify → (back to implement if verification fails) — that looks like it
needs a cycle. Conductor gets this by *not* being a strict DAG: its
`routes:` can point back to an earlier agent.

This schema keeps `steps`/`needs` strictly acyclic (so the graph stays
analyzable — you can always compute a static execution order) and expresses
the retry-back behavior instead as a bounded, explicit unrolling:

```yaml
retry:
  until: "{{ steps.verify.outputs.passed == true }}"
  max_attempts: 3
  rerun: [implement, verify]
```

`rerun` names the steps to re-execute — it's a re-run instruction, not a graph
edge. The DAG itself never has a back-edge; the runtime just knows to loop
`[implement, verify]` up to `max_attempts` times. This is the schema's answer
to "three iteration semantics, three constructs" for the whole-cycle case.

### Three iteration semantics, three constructs

patterns.md found three things that all get called "loop":

| Semantics | Construct | Precedent |
|---|---|---|
| Map a step over a list of inputs, run instances in parallel | `strategy.matrix` | Conductor's `for_each` |
| Repeat a whole plan→act→verify cycle until a condition holds | `retry.rerun` | Conductor's conditional routing (adapted to stay acyclic — see above) |
| Let one step iterate internally until it self-reports done | `max_steps` + `until` | Taskflow's `repeat_prompt` + `max_steps` |

Keeping these as three separate fields (rather than one generic `loop:`
block) means the state and stop-condition concerns for each stay legible:
matrix iteration needs `max_parallel`/`on_error`, cycle retry needs
`max_attempts`/`rerun`, internal iteration needs `max_steps`/`until` — none
of those options make sense on the other two.

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
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)

## Minimal MVP increment

The full schema above is the target shape, not the starting point. A useful
first cut needs enough to be a real loop tool — a DAG, at least one way to
stop, and state that survives a crash — without the machinery that only pays
off once there's more than one workflow to reuse or more than one person
involved in a run.

**MVP field set:**

- `wish` (optional, defaults to `"1"`), `name` — identity
- `steps.<id>.needs` — the DAG, no `if:` (branching deferred)
- `steps.<id>.type: agent | script` — only these two step types
- `steps.<id>.model` / `prompt` / `tools` — inlined directly on the step; no
  top-level `agents:`/`tools:` registries yet (those only pay for themselves
  once handoff or cross-step reuse exists)
- `steps.<id>.outputs` — typed, addressable outputs; the DAG can't pass data
  between steps without this, so it isn't optional even at MVP
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
    needs: [test]
    type: agent
    model: claude-sonnet-5
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
| `if:` conditional routing | Branching only matters once a workflow has more than one possible path; a straight-line DAG covers the first real use cases |
| `type: human_gate` | Needs an approval/notification surface (who gets asked, how) that doesn't exist yet — infrastructure, not schema |
| `strategy.matrix` | Parallel fan-out matters once there's a real list-of-things use case; premature before that |
| `retry`/`rerun` (cycle retry) | The bounded-loop-back semantics are the most novel/riskiest part of the design (see rationale above) — worth proving out the simple case first |
| `agents:`/`tools:` registries, `handoff` | Only pay off with reuse across steps or multiple agent identities in one run; a single inline agent per step is enough until then |
| `type: workflow` (`uses`/`with`) | Composability matters once there's more than one workflow file to compose |
| `context.mode` | `accumulate` is a reasonable fixed default until context-cost becomes an actual problem |
| `hooks` | Observability beyond the state file and transcripts can wait until something is consuming those events |
| `transcripts:` (as configurable YAML) | Ship with transcripts always-on, unconfigurable, at a fixed path — configurability isn't needed until there's a reason to turn them off |
| `on:` triggers | A CLI invocation (`wish <name>`) is sufficient before scheduling/webhooks are needed |

**Suggested sequencing** after MVP: `if:` + `type: human_gate` next (the
two cheapest, most-requested additions), then `strategy.matrix`, then
`retry`/`rerun`, with registries/`handoff`/composability/`hooks` last since
they're the parts of the schema this design is least battle-tested on.
