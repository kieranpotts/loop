# Design requirements

Draft requirements for Loop, informed by the pattern survey in
[patterns.md](./patterns.md) and by GitHub Actions' workflow YAML grammar.
This is a design-stage document — a working list to refine before it becomes
the project's actual [requirements.md](../requirements.md).

> **Revision (2026-07-30): sequential pipeline, not a DAG.** Requirements #1
> and #3 below originally called for a dependency graph with concurrent
> branches. Neither turned out to be a real need once actual usage was
> considered: the author's workflows don't have independent branches worth
> running concurrently, and even where they might, the practical execution
> backend (`genie`, routed through a local Ollama daemon) serializes model
> calls anyway — so concurrent steps would queue behind each other at the
> model layer regardless of what `wish` itself does. Building and maintaining
> DAG machinery (dependency validation, cycle detection, topological
> ordering) for a graph shape that's never actually branched isn't worth the
> complexity. `wish` therefore runs `steps` strictly in the order they're
> declared in the YAML — a sequential pipeline, not a graph. See
> [design.md](./design.md)'s design decisions for the full rationale.

## Core requirements

1. **YAML sequential pipeline**, taking inspiration from the three focus
   sources ([Open Agent Spec](https://www.openagentspec.dev/),
   [Conductor](https://github.com/microsoft/conductor),
   [Taskflow Agent](https://github.com/GitHubSecurityLab/seclab-taskflow-agent))
   and from [GitHub Actions'](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
   `steps:` grammar — specifically the step list *within* a job, which always
   runs sequentially with no dependency field, rather than the `jobs:` level
   (which supports `needs:` and concurrent execution). A format most
   engineers on this project will already have muscle memory for either way.
2. **Human gates** — a step type that pauses the run for approval before
   continuing. Conductor's `type: human_gate` (see patterns.md, "Mid-run
   control"). GitHub Actions' environment protection rules (required
   reviewers on an `environment:`) are the same idea expressed differently —
   worth comparing both shapes.
3. ~~**Parallel branches**~~ — removed. See the revision note above: not a
   real use case, and the practical execution backend would serialize
   concurrent model calls anyway.
4. **Mix of agentic and deterministic steps** — not every step should have
   to invoke a model. A shell command, an HTTP call, or a script step should
   be a first-class step type alongside an LLM step (cf. Taskflow's `run:`
   field for shell scripts returning JSON, GitHub Actions' `run:` vs `uses:`
   split).
5. **Agent handoffs** — one agent delegating to another mid-task, per
   Taskflow's handoff chain (patterns.md, "Mid-run control" and "Agent and
   tool wiring"). Distinct from a human gate: a handoff is a routing
   decision, not an approval decision.
6. **Stop conditions, iteration limits** — turn/step caps and explicit
   completion conditions, at minimum. See the expanded breakdown in
   "Additional candidates" below — this turned out to be at least three
   separate concerns once we looked closely at the sources.
7. **State and progress tracking** — persisted, resumable record of what a
   run has done. Needs a decision: named per-step outputs threaded through
   the pipeline (Open Agent Spec / Conductor's model), a checked-off plan
   file (`ohitslaurence/agent-loop`'s model), or both for different use
   cases.
8. **Session transcripts** — the full conversation/tool-call history for
   agentic steps, kept for audit and possible resumption.

## Additional candidates surfaced from the pattern research

These weren't on the original list but came up directly in
[patterns.md](./patterns.md). Flagging them for a decision rather than
assuming they're in scope.

- **Typed, addressable step outputs.** Both Open Agent Spec and Conductor
  give every step a declared output schema, referenced by later steps as
  `{{ step_name.output.field }}`. This is really a prerequisite for #7
  (state tracking) and for the pipeline itself — without it, "mix of
  agentic/deterministic steps" has no clean way to pass data between steps.
- **Tools and model as independent axes from the agent's identity.**
  Patterns.md's "Agent and tool wiring" section found three different
  answers here (Open Agent Spec: per-task `tools:`; Conductor: workflow +
  per-agent `tools:` list with separate `runtime.provider`; Taskflow:
  personality → toolbox indirection). Worth deciding explicitly rather than
  conflating "which model," "which tools," and "which prompt/persona" into
  one field.
- **Conditional / deterministic routing between steps.** Conductor evaluates
  `when:` expressions on routes with first-match-wins semantics, entirely
  outside the LLM. This is what makes a plan → implement → verify → (retry
  or end) cycle possible without a dedicated "loop" keyword. GitHub Actions'
  `if:` conditionals on jobs/steps are the same idea. This is closely
  related to #6 but distinct enough to call out — it's about *branching*,
  not *stopping*.
- **Three distinct iteration semantics, not one.** patterns.md's "Iteration
  constructs" section found the sources disagree about what "loop" means:
  (a) map a step over a list of inputs (Conductor's `for_each`), (b) repeat
  a whole plan→act→verify cycle until a condition holds (conditional routing
  back to an earlier step), (c) let a single step iterate internally until
  it self-reports done (Taskflow's `repeat_prompt` + `max_steps`). Item #6
  above ("stop conditions, iteration limits") likely needs to become three
  separate requirements, one per semantics.
- **Resource caps beyond iteration count.** Conductor separates
  `max_iterations` from `timeout_seconds` and `budget_usd` — wall-clock and
  cost are independent failure modes from "too many steps." Worth deciding
  whether Loop needs a cost cap given it's meant to run real model calls.
- **Retry policy, separate from stop conditions.** Conductor's per-agent
  `retry: { max_attempts, backoff, delay_seconds }` and `validator:
  { criteria, max_retries }` are about recovering from a bad single-step
  result, not about ending the whole run. Different concern from #6, easy to
  conflate.
- **Composable/reusable workflows.** Open Agent Spec lets a task delegate
  wholesale to another spec (`spec:`/`task:` fields, plus a hosted registry
  via `oa://` shorthand); Conductor has a `type: workflow` step that invokes
  another workflow file. GitHub Actions has the equivalent in reusable
  workflows (`workflow_call`). Not on the original list — worth deciding if
  Loop workflows should be composable this way, or if each YAML file is
  meant to stand alone.
- **Context propagation mode.** Conductor's `context_mode`
  (`accumulate` / `snapshot` / `minimal`) controls how much prior step output
  a given step actually sees. Related to #8 (session transcripts) but a
  distinct knob — full accumulation isn't free once a workflow has many
  steps.
- **Observability hooks.** patterns.md notes this is the one place the three
  focus sources sharply disagree: Conductor has first-class `hooks:`
  (`on_start`/`on_complete`/`on_error`); Open Agent Spec and Taskflow have
  nothing equivalent and leave it to the runtime. Not on the original list —
  worth an explicit decision instead of it falling out by accident.

## Open questions

- Is a Loop workflow file always single-purpose (like Open Agent Spec), or
  should workflows be composable/nestable (like Conductor's `type: workflow`
  or GitHub Actions' reusable workflows)?
- Does "state and progress tracking" (#7) need to support a human reading
  and hand-editing progress mid-run (plan-file model), or is
  read-only/resumable state via named outputs sufficient?
- Should stop conditions (#6) be split into the three distinct constructs
  identified above, or kept as one generic mechanism for v1?
