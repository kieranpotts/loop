// Executes a validated wish's `steps`.
//
// `type: script` steps run a shell command. `type: agent` steps run one
// single-shot call to `genie` (https://github.com/kieranpotts/genie) — not
// the Claude Agent SDK, and not multiple turns: `genie` has no session/resume
// flag, so an agent step that declares `until`/`max_steps` (internal
// iteration) is refused up front rather than silently run once. So is a step
// that declares `tools`: genie bakes tool access into its own hardened image
// at build time and has no per-invocation flag for it.
//
// `limits.max_turns` and `limits.timeout` are enforced (see runWish below).
// `limits.budget_usd` is not: cost tracking needs token usage pulled out of
// genie's `--json` stream plus a per-role pricing table, real separable work
// deferred for now.

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { stringify } from 'yaml'
import type { OutputField, Step, Wish } from './schema.ts'
import { matchesOutputType } from './schema.ts'
import { topologicalOrder } from './dag.ts'
import { parseDuration } from './duration.ts'

export type RunOutcome =
  | { ok: true, statePath?: string }
  | { ok: false, error: string }

interface TemplateContext {
  run: { id: string }
  steps: Record<string, { outputs: Record<string, unknown> }>
}

type StepState =
  | { status: 'pending' }
  | { status: 'success', outputs: Record<string, unknown> }
  | { status: 'failed', error: string }

interface StateDocument {
  run: { id: string, wish: string }
  steps: Record<string, StepState>
}

type StepResult =
  | { ok: true, outputs: Record<string, unknown> }
  | { ok: false, error: string }

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolvePath (context: TemplateContext, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = context
  for (const part of parts) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

/**
 * Replaces every `{{ path.to.value }}` in `text` using `context`.
 *
 * Throws if a reference doesn't resolve — an unresolved template is an error
 * in the wish, not a value to interpolate as "undefined".
 */
function substitute (text: string, context: TemplateContext): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(context, path)
    if (value === undefined) {
      throw new Error(`unresolved template reference: {{ ${path} }}`)
    }
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

function writeState (path: string, state: StateDocument): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringify(state))
}

/** Parses `raw` as JSON and checks it against a step's declared `outputs`. */
function parseAndValidateOutputs (
  id: string,
  raw: string,
  outputFields: Array<[string, OutputField]>,
  sourceLabel: string
): StepResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: `step '${id}': ${sourceLabel} is not valid JSON (outputs are declared, so it must be a JSON object)` }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: `step '${id}': ${sourceLabel} must be a JSON object` }
  }

  for (const [field, spec] of outputFields) {
    if (!(field in parsed)) {
      return { ok: false, error: `step '${id}': output '${field}' missing from ${sourceLabel}` }
    }
    if (!matchesOutputType(parsed[field], spec.type)) {
      return { ok: false, error: `step '${id}': output '${field}' does not match declared type '${spec.type}'` }
    }
  }

  return { ok: true, outputs: parsed }
}

function runScriptStep (
  id: string,
  step: Step & { type: 'script' },
  context: TemplateContext,
  timeoutMs?: number
): StepResult {
  let command: string
  try {
    command = substitute(step.run, context)
  } catch (error) {
    return { ok: false, error: `step '${id}': ${(error as Error).message}` }
  }

  const outputFields = Object.entries(step.outputs ?? {})
  const hasOutputs = outputFields.length > 0

  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    stdio: hasOutputs ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: timeoutMs,
  })

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    const detail = timedOut ? `timed out after ${timeoutMs}ms (limits.timeout)` : result.error.message
    return { ok: false, error: `step '${id}': ${detail}` }
  }
  if (result.status !== 0) {
    const detail = hasOutputs && result.stderr ? `: ${result.stderr.trim()}` : ''
    return { ok: false, error: `step '${id}': command exited with status ${result.status}${detail}` }
  }

  if (!hasOutputs) {
    return { ok: true, outputs: {} }
  }

  return parseAndValidateOutputs(id, result.stdout, outputFields, 'stdout')
}

/** The instruction appended to a prompt when a step declares `outputs`. */
function buildOutputInstruction (outputFields: Array<[string, OutputField]>): string {
  const fields = outputFields.map(([field, spec]) => `- ${field}: ${spec.type}`).join('\n')
  return `Respond with a single JSON object and no other text, with exactly these fields:\n${fields}`
}

interface GenieContentPart {
  type: string
  text?: string
}

interface GenieMessage {
  role: string
  content?: GenieContentPart[]
}

/**
 * Pulls the final assistant reply out of `genie --json`'s output: one JSON
 * event per line, of which only the last `message_end` with `role:
 * "assistant"` is the answer. See genie's own README for this contract.
 */
function extractAssistantText (jsonl: string): { ok: true, text: string } | { ok: false, error: string } {
  let lastMessage: GenieMessage | undefined

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: 'received a non-JSON line from genie --json output' }
    }

    if (isRecord(event) && event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
      lastMessage = event.message as unknown as GenieMessage
    }
  }

  if (!lastMessage) {
    return { ok: false, error: 'no assistant message_end event in genie --json output' }
  }

  const text = (lastMessage.content ?? [])
    .filter((part): part is { type: 'text', text: string } => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')

  return { ok: true, text }
}

function runAgentStep (
  id: string,
  step: Step & { type: 'agent' },
  context: TemplateContext,
  timeoutMs?: number
): StepResult {
  let prompt: string
  try {
    prompt = substitute(step.prompt, context)
  } catch (error) {
    return { ok: false, error: `step '${id}': ${(error as Error).message}` }
  }

  const outputFields = Object.entries(step.outputs ?? {})
  const hasOutputs = outputFields.length > 0
  const fullPrompt = hasOutputs ? `${prompt}\n\n${buildOutputInstruction(outputFields)}` : prompt

  const args = ['-p', fullPrompt, '-m', step.model]
  if (hasOutputs) args.push('--json')

  const result = spawnSync('genie', args, {
    encoding: 'utf8',
    stdio: hasOutputs ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: timeoutMs,
  })

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException
    const detail = errno.code === 'ENOENT'
      ? 'genie not found on PATH — install it from https://github.com/kieranpotts/genie'
      : errno.code === 'ETIMEDOUT'
        ? `timed out after ${timeoutMs}ms (limits.timeout)`
        : result.error.message
    return { ok: false, error: `step '${id}': ${detail}` }
  }
  if (result.status !== 0) {
    const detail = hasOutputs && result.stderr ? `: ${result.stderr.trim()}` : ''
    return { ok: false, error: `step '${id}': genie exited with status ${result.status}${detail}` }
  }

  if (!hasOutputs) {
    return { ok: true, outputs: {} }
  }

  const extracted = extractAssistantText(result.stdout)
  if (!extracted.ok) {
    return { ok: false, error: `step '${id}': ${extracted.error}` }
  }

  return parseAndValidateOutputs(id, extracted.text, outputFields, "the agent's response")
}

export function runWish (wish: Wish): RunOutcome {
  for (const [id, step] of Object.entries(wish.steps)) {
    if (step.type !== 'agent') continue

    if (step.until !== undefined || step.max_steps !== undefined) {
      return {
        ok: false,
        error: `step '${id}': 'until'/'max_steps' need internal iteration, which isn't implemented yet — agent steps currently run once`,
      }
    }
    if (step.tools !== undefined && step.tools.length > 0) {
      return {
        ok: false,
        error: `step '${id}': 'tools' isn't supported yet — genie doesn't expose per-invocation tool selection (tools come from its own hardened image)`,
      }
    }
  }

  const order = topologicalOrder(wish.steps)
  const context: TemplateContext = { run: { id: randomUUID() }, steps: {} }

  let statePath: string | undefined
  let state: StateDocument | undefined

  if (wish.state) {
    try {
      statePath = substitute(wish.state.path, context)
    } catch (error) {
      return { ok: false, error: `state.path: ${(error as Error).message}` }
    }
    state = {
      run: { id: context.run.id, wish: wish.name },
      steps: Object.fromEntries(Object.keys(wish.steps).map(id => [id, { status: 'pending' as const }])),
    }
    writeState(statePath, state)
  }

  // `parseDuration` cannot fail here — validateWish already rejected any
  // `limits.timeout` it doesn't accept — but the return type stays nullable
  // since that guarantee lives in a different function. `?? undefined`
  // treats the (unreachable) failure case as "no timeout" rather than 0ms.
  const maxTurns = wish.limits?.max_turns
  const timeoutMs = wish.limits?.timeout ? (parseDuration(wish.limits.timeout) ?? undefined) : undefined
  const startTime = Date.now()

  let turns = 0

  for (const id of order) {
    turns++
    if (maxTurns !== undefined && turns > maxTurns) {
      return { ok: false, error: `limits.max_turns (${maxTurns}) reached before step '${id}' could run` }
    }

    let stepTimeoutMs: number | undefined
    if (timeoutMs !== undefined) {
      const remaining = timeoutMs - (Date.now() - startTime)
      if (remaining <= 0) {
        return { ok: false, error: `limits.timeout (${wish.limits!.timeout}) reached before step '${id}' could run` }
      }
      stepTimeoutMs = remaining
    }

    const step = wish.steps[id] as Step
    const result = step.type === 'script'
      ? runScriptStep(id, step, context, stepTimeoutMs)
      : runAgentStep(id, step, context, stepTimeoutMs)

    if (!result.ok) {
      if (state && statePath) {
        state.steps[id] = { status: 'failed', error: result.error }
        writeState(statePath, state)
      }
      return result
    }

    context.steps[id] = { outputs: result.outputs }

    if (state && statePath) {
      state.steps[id] = { status: 'success', outputs: result.outputs }
      writeState(statePath, state)
    }
  }

  return statePath ? { ok: true, statePath } : { ok: true }
}
