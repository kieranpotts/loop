// Executes a validated wish's `jobs`.
//
// Scope for now: `type: script` jobs only, run in dependency order. A wish
// containing any `type: agent` job is refused up front, cleanly, rather than
// run partially — agent execution (via `genie`, not the Claude Agent SDK
// directly) is a later increment. So is `state.path` persistence and
// `limits` enforcement: both are real, separable pieces of work, not part
// of "can a DAG of scripts run and pass data to each other."

import { spawnSync } from 'node:child_process'
import type { Job, OutputField, Wish } from './schema.ts'
import { matchesOutputType } from './schema.ts'
import { topologicalOrder } from './dag.ts'

export type RunOutcome =
  | { ok: true }
  | { ok: false, error: string }

interface TemplateContext {
  jobs: Record<string, { outputs: Record<string, unknown> }>
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

function runScriptJob (
  id: string,
  job: Job & { type: 'script' },
  context: TemplateContext
): { ok: true, outputs: Record<string, unknown> } | { ok: false, error: string } {
  let command: string
  try {
    command = substitute(job.run, context)
  } catch (error) {
    return { ok: false, error: `job '${id}': ${(error as Error).message}` }
  }

  const outputFields = Object.entries(job.outputs ?? {})
  const hasOutputs = outputFields.length > 0

  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    stdio: hasOutputs ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (result.error) {
    return { ok: false, error: `job '${id}': ${result.error.message}` }
  }
  if (result.status !== 0) {
    const detail = hasOutputs && result.stderr ? `: ${result.stderr.trim()}` : ''
    return { ok: false, error: `job '${id}': command exited with status ${result.status}${detail}` }
  }

  if (!hasOutputs) {
    return { ok: true, outputs: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { ok: false, error: `job '${id}': stdout is not valid JSON (outputs are declared, so stdout must be a JSON object)` }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: `job '${id}': stdout must be a JSON object` }
  }

  for (const [field, spec] of outputFields as Array<[string, OutputField]>) {
    if (!(field in parsed)) {
      return { ok: false, error: `job '${id}': output '${field}' missing from stdout` }
    }
    if (!matchesOutputType(parsed[field], spec.type)) {
      return { ok: false, error: `job '${id}': output '${field}' does not match declared type '${spec.type}'` }
    }
  }

  return { ok: true, outputs: parsed }
}

export function runWish (wish: Wish): RunOutcome {
  for (const [id, job] of Object.entries(wish.jobs)) {
    if (job.type !== 'script') {
      return {
        ok: false,
        error: `job '${id}': type '${job.type}' is not executable yet (only 'script' jobs run in this build)`,
      }
    }
  }

  const order = topologicalOrder(wish.jobs)
  const context: TemplateContext = { jobs: {} }

  for (const id of order) {
    const job = wish.jobs[id] as Job & { type: 'script' }
    const result = runScriptJob(id, job, context)
    if (!result.ok) return result
    context.jobs[id] = { outputs: result.outputs }
  }

  return { ok: true }
}
