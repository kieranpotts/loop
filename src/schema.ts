// Validates a parsed wish against the MVP field set from
// docs/design/design.md's "Minimal MVP increment": `loop`/`name`, `jobs`
// with `needs`/`type: agent | script`/`outputs`, `max_steps`/`until`,
// workflow-wide `limits`, and `state.path`. Everything else the full schema
// proposes (`if`, `human_gate`, `strategy.matrix`, `retry`, agent/tool
// registries, `uses`, `context.mode`, `hooks`) is deliberately out of scope
// until those increments land.

import { findCycle } from './dag.ts'

export type JobType = 'agent' | 'script'

export interface OutputField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
}

interface JobBase {
  needs?: string[]
  outputs?: Record<string, OutputField>
}

export type Job =
  | (JobBase & { type: 'script', run: string })
  | (JobBase & {
    type: 'agent'
    model: string
    prompt: string
    tools?: string[]
    max_steps?: number
    until?: string
  })

export interface Limits {
  max_turns?: number
  timeout?: string
  budget_usd?: number
}

export interface State {
  path: string
}

export interface Wish {
  loop: string
  name: string
  limits?: Limits
  state?: State
  jobs: Record<string, Job>
}

export type ValidationResult =
  | { ok: true, errors: [], wish: Wish }
  | { ok: false, errors: string[] }

const JOB_TYPES = ['agent', 'script'] as const
const OUTPUT_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringArray (value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isPositiveInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Whether a runtime value matches a declared output field's type. */
export function matchesOutputType (value: unknown, type: OutputField['type']): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return isRecord(value)
  }
}

function validateOutputs (value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return

  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`)
    return
  }

  for (const [field, spec] of Object.entries(value)) {
    const fieldPath = `${path}.${field}`
    if (!isRecord(spec) || !isNonEmptyString(spec.type)) {
      errors.push(`${fieldPath}: must be an object with a 'type' field`)
      continue
    }
    if (!(OUTPUT_TYPES as readonly string[]).includes(spec.type)) {
      errors.push(`${fieldPath}.type: must be one of ${OUTPUT_TYPES.join(', ')}`)
    }
  }
}

function validateJob (value: unknown, id: string, jobIds: Set<string>, errors: string[]): void {
  const path = `jobs.${id}`

  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`)
    return
  }

  if (value.needs !== undefined) {
    if (!isStringArray(value.needs)) {
      errors.push(`${path}.needs: must be an array of job names`)
    } else {
      for (const dep of value.needs) {
        if (!jobIds.has(dep)) errors.push(`${path}.needs: references unknown job '${dep}'`)
      }
    }
  }

  const type = value.type
  if (!isNonEmptyString(type) || !(JOB_TYPES as readonly string[]).includes(type)) {
    errors.push(`${path}.type: must be 'agent' or 'script'`)
    return
  }

  if (type === 'agent') {
    if (!isNonEmptyString(value.model)) errors.push(`${path}.model: required for an agent job`)
    if (!isNonEmptyString(value.prompt)) errors.push(`${path}.prompt: required for an agent job`)
    if (value.tools !== undefined && !isStringArray(value.tools)) {
      errors.push(`${path}.tools: must be an array of tool names`)
    }
    if (value.max_steps !== undefined && !isPositiveInteger(value.max_steps)) {
      errors.push(`${path}.max_steps: must be a positive integer`)
    }
    if (value.until !== undefined && !isNonEmptyString(value.until)) {
      errors.push(`${path}.until: must be a non-empty string`)
    }
    if (value.run !== undefined) errors.push(`${path}.run: not valid on an agent job`)
  } else {
    if (!isNonEmptyString(value.run)) errors.push(`${path}.run: required for a script job`)
    for (const field of ['model', 'prompt', 'tools', 'max_steps', 'until'] as const) {
      if (value[field] !== undefined) errors.push(`${path}.${field}: not valid on a script job`)
    }
  }

  validateOutputs(value.outputs, `${path}.outputs`, errors)
}

export function validateWish (value: unknown): ValidationResult {
  const errors: string[] = []

  if (!isRecord(value)) {
    return { ok: false, errors: ['must be a YAML mapping'] }
  }

  if (!isNonEmptyString(value.loop)) errors.push("loop: required (schema version, e.g. '1')")
  if (!isNonEmptyString(value.name)) errors.push('name: required')

  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) {
      errors.push('limits: must be an object')
    } else {
      const { max_turns: maxTurns, timeout, budget_usd: budgetUsd } = value.limits
      if (maxTurns !== undefined && !isPositiveInteger(maxTurns)) {
        errors.push('limits.max_turns: must be a positive integer')
      }
      if (timeout !== undefined && !isNonEmptyString(timeout)) {
        errors.push('limits.timeout: must be a duration string, e.g. "45m"')
      }
      if (budgetUsd !== undefined && !(typeof budgetUsd === 'number' && budgetUsd >= 0)) {
        errors.push('limits.budget_usd: must be a non-negative number')
      }
    }
  }

  if (value.state !== undefined) {
    if (!isRecord(value.state) || !isNonEmptyString(value.state.path)) {
      errors.push('state.path: required when state is set')
    }
  }

  if (!isRecord(value.jobs) || Object.keys(value.jobs).length === 0) {
    errors.push('jobs: required, must be a non-empty object')
  } else {
    const jobs = value.jobs
    const jobIds = new Set(Object.keys(jobs))

    for (const id of jobIds) {
      validateJob(jobs[id], id, jobIds, errors)
    }

    const cycle = findCycle(jobs as Record<string, { needs?: string[] }>)
    if (cycle) errors.push(`jobs: cyclic 'needs' dependency: ${cycle.join(' -> ')}`)
  }

  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, errors: [], wish: value as unknown as Wish }
}
