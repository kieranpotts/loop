# Agent loop engineering patterns

Primary sources: [Open Agent Spec](https://www.openagentspec.dev/),
[Microsoft Conductor](https://github.com/microsoft/conductor), and
[GitHub Security Lab's Taskflow Agent](https://github.com/GitHubSecurityLab/seclab-taskflow-agent) —
three YAML-first agent/workflow definition formats. [`ohitslaurence/agent-loop`](https://github.com/ohitslaurence/agent-loop)
is referenced as a secondary contrast point: a much simpler, code-free,
Markdown-plan-driven loop. [`cobusgreyling/loop-engineering`](https://github.com/cobusgreyling/loop-engineering/tree/main)
is a further secondary reference, of a different kind again — see "Operational
loop patterns" below.

## Workflow-graph state (per-step outputs, DAG-shaped)

Conductor and Open Agent Spec both model state as **named step outputs**
threaded through a dependency graph, rather than a single linear
conversation. Each step's output becomes addressable context for later steps:

```yaml
# Conductor: later steps reference earlier ones by name
agents:
  - name: planner
    output:
      steps: { type: array }
  - name: implementer
    prompt: |
      Follow this plan:
      {{ planner.output.steps }}
```

```yaml
# Open Agent Spec: explicit depends_on, output schema per task
tasks:
  research:
    output: { facts: string }
  summarize:
    depends_on: [research]
    prompts:
      user: "Summarize: {{ research.facts }}"
```

This scales better to multi-agent/parallel workflows, since state is
naturally partitioned per step, but it gives up the "just read one file"
simplicity of a plan-file loop like `ohitslaurence/agent-loop`, where the
agent edits a Markdown checklist directly and the checked-off file plus git
history *is* the state — nothing else to persist.

Open Agent Spec is explicit that its DAG model comes at a cost: it is
"linear, declarative, and strictly not an orchestration engine". It has no
loop or iteration construct at all. Recurring/iterative behavior has to be
driven from outside the spec (an external scheduler re-invoking it), which is
a deliberate scope cut.

**Takeaway for design**: a DAG of named step outputs suits multi-agent,
parallel, or dependency-shaped work. A single checked-off plan file suits a
single agent grinding through a linear task list where a human may want to
read or hand-edit progress directly. Pick based on shape of the work, not
convenience.

## Iteration constructs in YAML-defined workflows

Since Loop's stated goal is specifying agentic workflows from YAML, it's
worth comparing how the three formats express repetition — because they land
on genuinely different answers.

**Open Agent Spec has no loop construct.** Tasks form a DAG via `depends_on`;
each task runs exactly once. Iteration is explicitly pushed to whatever
invokes the spec.

**Conductor has two distinct repetition primitives** — static parallel
fan-out and dynamic per-item iteration — plus workflow-level iteration limits
that bound a *whole workflow* re-running (e.g. a plan → implement → verify →
[back to plan if verification fails] cycle), not just a single step:

```yaml
# Dynamic loop: run one agent instance per item in an array
for_each:
  - name: process_issues
    source: epic_planner.output.issues
    as: issue
    agent:
      prompt: "Process {{ issue.title }}, index {{ _index }}"
    max_concurrent: 10
    failure_mode: fail_fast
```

```yaml
# Parallel fan-out: fixed set of agents run concurrently
parallel:
  - name: parallel_validators
    agents: [security_check, performance_check, style_check]
    failure_mode: continue_on_error
```

Routing between steps is conditional and evaluated with Jinja2, giving you a
plan → implement → verify → (retry or end) cycle expressed as ordinary
step-to-step routes rather than a dedicated "loop" keyword:

```yaml
agents:
  - name: verifier
    prompt: "Verify the implementation matches the plan"
    routes:
      - to: implementer
        when: "{{ verifier.output.passed == false }}"
      - to: $end
```

**Taskflow Agent's `repeat_prompt`** is the most literal "loop" keyword of the
three: it templates a single task's prompt over a set of results, re-running
the same task once per item, rather than expressing a graph of distinct
steps. Combined with its `max_steps` and `must_complete` fields, a single
task can iterate on its own until a completion condition is satisfied,
without that iteration being visible in the workflow graph at all:

```yaml
taskflow:
  - task:
      model: gpt-4.1
      max_steps: 20
      must_complete: true
      repeat_prompt: "Next item: {{ item }}"
```

**Takeaway for design**: "loop" can mean at least three different things —
(a) repeat one step over a list of inputs, (b) repeat a whole
plan→act→verify cycle until a condition holds, (c) let a single task iterate
internally until it self-reports completion. These are worth naming as
distinct YAML constructs rather than one generic `loop:` block, because the
state and stop-condition concerns differ for each.

## Agent and tool wiring

The three formats take different approaches to how a step gets access to
tools and how work hands off between agents:

- **Open Agent Spec** declares tools directly per task, with three
  varieties: native tools (`file.read`, `http.get`), MCP servers via
  JSON-RPC, and custom Python implementations. Tasks can also delegate
  wholesale to another spec via `spec:`/`task:` fields, reusing a specialist
  agent definition rather than re-declaring its tools.
- **Conductor** declares a workflow-level `tools:` list available to all
  agents, plus per-agent `tools:` overrides, and separates that from
  `runtime.provider` (Copilot or Anthropic), so which tools an agent can call
  and which model backs it are independent choices.
- **Taskflow Agent** indirects through **personalities** and **toolboxes**:
  a personality defines a system prompt and default toolbox access; a
  toolbox wraps one or more MCP servers. A task can override a personality's
  toolboxes outright, and can list multiple agents as a **handoff chain**:

  ```yaml
  taskflow:
    - task:
        model: gpt-4.1
        max_steps: 20
        must_complete: true
        agents:
          - seclab_taskflow_agent.personalities.c_auditer
          - examples.personalities.fruit_expert
        user_prompt: |
          Store vulnerable C code in memory and explain strcpy
          insecurity. Hand off to discuss fruit health benefits.
        toolboxes:
          - seclab_taskflow_agent.toolboxes.memcache
        headless: true
  ```

  The first agent in `agents:` runs; if it hands off, the next agent in the
  list picks up with (by default) the same toolbox access, unless the task
  overrides it.

**Takeaway for design**: separate three independent axes — which *model*
backs a step, which *tools* it can call, and which *agent identity/prompt*
it runs as. Open Agent Spec and Conductor keep tools attached directly to a
task/agent; Taskflow's personality/toolbox layer is an extra level of
indirection that pays off specifically when the same toolbox needs to be
shared or swapped across many agent definitions.

## Mid-run control

Two different mechanisms show up for changing what happens *during* a run,
rather than only before it starts or after it ends:

- **Human gates** (Conductor): a workflow step of `type: human_gate` pauses
  the workflow for approval before continuing:

  ```yaml
  agents:
    - name: approval
      type: human_gate
      options:
        - name: approve
          description: "Approve and proceed"
        - name: reject
          description: "Reject and halt"
  ```

- **Agent handoff** (Taskflow Agent): control passes from one agent to
  another *within* a task, as shown above — a hard-coded escalation/delegation
  path declared up front, rather than a runtime pause waiting on a human.

Conductor's gate gives an external actor (a human) veto power over
continuation. Taskflow's handoff gives one agent the ability to delegate to
another agent with different tools/personality, mid-task, without leaving
the loop. Neither is a substitute for the other: a gate answers "should this
continue," a handoff answers "who should continue this."

**Takeaway for design**: decide separately whether a workflow needs (a) a
pause point for human approval and (b) a way for one agent to delegate to a
better-suited agent mid-task. Both are useful; conflating them into one
"pause and reassign" primitive would blur what's actually a policy decision
(approve/reject) versus a routing decision (who runs next).

## Observability

Of the three primary formats, only Conductor defines an explicit
observability surface in its YAML: lifecycle `hooks` that fire on workflow
start/complete/error, expressed as the same Jinja2 templates used elsewhere
in the spec:

```yaml
workflow:
  hooks:
    on_start: "{{ log('workflow started: ' + workflow.name) }}"
    on_error: "{{ notify_slack(error.message) }}"
```

Neither Open Agent Spec nor Taskflow Agent define an equivalent field —
Taskflow's `headless: true` (disabling tool-confirmation prompts) is the
closest thing, and it's a permission concern, not an observability one.
`ohitslaurence/agent-loop` covers this need differently again, outside the
task spec entirely: it writes plain iteration logs to
`logs/loop/run-<id>/` as a side effect of the harness running the loop.

**Takeaway for design**: don't assume an observability story falls out of
the workflow spec format for free. Of the three, only Conductor treats it as
a first-class field; the others leave it to the runtime/harness. Decide
explicitly whether Loop's YAML should declare hooks the way Conductor does,
or whether observability belongs entirely to the harness that executes the
YAML (closer to how `ohitslaurence/agent-loop` handles it).

## Operational loop patterns

[`cobusgreyling/loop-engineering`](https://github.com/cobusgreyling/loop-engineering/tree/main)
is a different kind of reference than the three focus sources above: it isn't
a YAML workflow-definition format at all, but a collection of named,
production loop *patterns* (Daily Triage, PR Babysitter, CI Sweeper, and
others, indexed in `patterns/registry.yaml`), starter kits per coding agent
(Claude Code, Codex, Grok, Opencode), and CLI tooling for loop governance —
`loop-init` to scaffold a new loop, `loop-audit` for a readiness score,
`loop-cost` for spend tracking, `loop-gate` for approval gates. It publishes
no formal schema for a loop definition; instead it generates plain governance
documents (`STATE.md`, `LOOP.md`, `loop-constraints.md`, `loop-budget.md`,
`loop-run-log.md`) that track what a loop is allowed to do and what it has
done.

**Takeaway for design**: this repo's value to Loop isn't schema shape — it
has none to borrow — but its pattern library and governance-document set are
worth returning to once Loop has a working MVP, as a check on whether real
recurring use cases (a daily triage loop, a PR babysitter) are actually
expressible in Loop's YAML, and whether `state.path` and `limits:` cover the
same ground as its `STATE.md`/`loop-budget.md`/`loop-run-log.md` split.

-----

## Cross-reference summary

| Concern | Open Agent Spec | Conductor | Taskflow Agent | Plan-file loop (`ohitslaurence/agent-loop`) |
|---|---|---|---|---|
| Config format | YAML | YAML | YAML | Markdown + CLI flags |
| Loop construct | **None** — DAG only | `for_each`, `parallel`, conditional routes | `repeat_prompt` per task | Implicit (re-run until sentinel) |
| Stop conditions | N/A (single pass) | `limits.max_iterations`, `timeout_seconds`, `budget_usd` | `max_steps`, `must_complete` | Sentinel token + iteration cap |
| State model | Per-task output schema, `depends_on` DAG | Named step outputs, `context_mode` | Per-task, via memcache toolbox | Checked-off plan file + git |
| Tool wiring | Per-task `tools:` (native/MCP/custom) | Workflow + per-agent `tools:` list | Personality → toolbox indirection | N/A |
| Mid-run control | N/A | `human_gate` step type | Agent handoff chain | Manual plan edit |
| Observability | N/A | Lifecycle `hooks` | N/A (headless mode) | Iteration logs |

-----

## Sources

- [Open Agent Spec](https://www.openagentspec.dev/) /
  [GitHub](https://github.com/prime-vector/open-agent-spec)
- [Microsoft Conductor](https://github.com/microsoft/conductor) /
  [workflow-syntax.md](https://github.com/microsoft/conductor/blob/main/docs/workflow-syntax.md) /
  [parallel-execution.md](https://github.com/microsoft/conductor/blob/main/docs/parallel-execution.md)
- [GitHubSecurityLab/seclab-taskflow-agent](https://github.com/GitHubSecurityLab/seclab-taskflow-agent)
- [`ohitslaurence/agent-loop`](https://github.com/ohitslaurence/agent-loop)
- [`cobusgreyling/loop-engineering`](https://github.com/cobusgreyling/loop-engineering/tree/main)
