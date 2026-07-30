// Executes a validated wish's `steps`.
//
// Scope for now: `type: script` steps only, run in dependency order. A wish
// containing any `type: agent` step is refused up front, cleanly, rather than
// run partially — agent execution (via `genie`, not the Claude Agent SDK
// directly) is a later increment. So is `limits` enforcement: a real,
// separable piece of work, not part of "can a DAG of scripts run and pass
// data to each other, with progress written to state.path."

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { stringify } from 'yaml'
import type { OutputField, Step, Wish } from './schema.ts'
import { matchesOutputType } from './schema.ts'
import { topologicalOrder } from './dag.ts'

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

function runScriptStep (
  id: string,
  step: Step & { type: 'script' },
  context: TemplateContext
): { ok: true, outputs: Record<string, unknown> } | { ok: false, error: string } {
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
  })

  if (result.error) {
    return { ok: false, error: `step '${id}': ${result.error.message}` }
  }
  if (result.status !== 0) {
    const detail = hasOutputs && result.stderr ? `: ${result.stderr.trim()}` : ''
    return { ok: false, error: `step '${id}': command exited with status ${result.status}${detail}` }
  }

  if (!hasOutputs) {
    return { ok: true, outputs: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { ok: false, error: `step '${id}': stdout is not valid JSON (outputs are declared, so stdout must be a JSON object)` }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: `step '${id}': stdout must be a JSON object` }
  }

  for (const [field, spec] of outputFields as Array<[string, OutputField]>) {
    if (!(field in parsed)) {
      return { ok: false, error: `step '${id}': output '${field}' missing from stdout` }
    }
    if (!matchesOutputType(parsed[field], spec.type)) {
      return { ok: false, error: `step '${id}': output '${field}' does not match declared type '${spec.type}'` }
    }
  }

  return { ok: true, outputs: parsed }
}

export function runWish (wish: Wish): RunOutcome {
  for (const [id, step] of Object.entries(wish.steps)) {
    if (step.type !== 'script') {
      return {
        ok: false,
        error: `step '${id}': type '${step.type}' is not executable yet (only 'script' steps run in this build)`,
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

  for (const id of order) {
    const step = wish.steps[id] as Step & { type: 'script' }
    const result = runScriptStep(id, step, context)

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
