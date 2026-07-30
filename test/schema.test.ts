import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateWish } from '../src/schema.ts'

const validWish = {
  loop: '1',
  name: 'fix-and-verify',
  limits: { max_turns: 200, timeout: '45m', budget_usd: 10 },
  state: { path: '.loop/runs/{{ run.id }}/state.yaml' },
  jobs: {
    test: {
      type: 'script',
      run: 'npm test -- --json',
      outputs: { failures: { type: 'array' } },
    },
    implement: {
      needs: ['test'],
      type: 'agent',
      model: 'claude-sonnet-5',
      tools: ['shell'],
      prompt: 'Fix the failures: {{ jobs.test.outputs.failures }}',
      max_steps: 20,
      until: '{{ jobs.implement.outputs.tests_pass == true }}',
      outputs: { tests_pass: { type: 'boolean' } },
    },
  },
}

describe('validateWish — the MVP example from design.md', () => {
  it('accepts it as-is', () => {
    const result = validateWish(validWish)
    assert.equal(result.ok, true)
  })

  it('accepts a minimal wish with only loop, name and one script job', () => {
    const result = validateWish({
      loop: '1',
      name: 'hello',
      jobs: { greet: { type: 'script', run: 'echo hi' } },
    })
    assert.equal(result.ok, true)
  })
})

describe('validateWish — top-level fields', () => {
  it('rejects a non-object value', () => {
    const result = validateWish('not an object')
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('must be a YAML mapping'))
  })

  it('requires loop and name', () => {
    const result = validateWish({ jobs: { a: { type: 'script', run: 'x' } } })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.some(e => e.startsWith('loop:')))
    assert.ok(!result.ok && result.errors.some(e => e.startsWith('name:')))
  })

  it('requires jobs to be a non-empty object', () => {
    const result = validateWish({ loop: '1', name: 'x', jobs: {} })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('jobs: required, must be a non-empty object'))
  })
})

describe('validateWish — limits', () => {
  it('rejects a non-positive-integer max_turns', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      limits: { max_turns: 0 },
      jobs: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('limits.max_turns: must be a positive integer'))
  })

  it('rejects a negative budget_usd', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      limits: { budget_usd: -1 },
      jobs: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('limits.budget_usd: must be a non-negative number'))
  })
})

describe('validateWish — state', () => {
  it('requires state.path when state is set', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      state: {},
      jobs: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('state.path: required when state is set'))
  })
})

describe('validateWish — job.needs', () => {
  it('rejects a needs entry that names an unknown job', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { needs: ['missing'], type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes("jobs.a.needs: references unknown job 'missing'"))
  })

  it('rejects a two-job cycle', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: {
        a: { needs: ['b'], type: 'script', run: 'x' },
        b: { needs: ['a'], type: 'script', run: 'x' },
      },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.some(e => e.startsWith("jobs: cyclic 'needs' dependency:")))
  })

  it('accepts a diamond dependency shape (not a cycle)', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: {
        a: { type: 'script', run: 'x' },
        b: { needs: ['a'], type: 'script', run: 'x' },
        c: { needs: ['a'], type: 'script', run: 'x' },
        d: { needs: ['b', 'c'], type: 'script', run: 'x' },
      },
    })
    assert.equal(result.ok, true)
  })
})

describe('validateWish — job.type', () => {
  it('rejects an unknown job type', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'human_gate' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes("jobs.a.type: must be 'agent' or 'script'"))
  })

  it('requires model and prompt on an agent job, and rejects run', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'agent', run: 'echo hi' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('jobs.a.model: required for an agent job'))
    assert.ok(!result.ok && result.errors.includes('jobs.a.prompt: required for an agent job'))
    assert.ok(!result.ok && result.errors.includes('jobs.a.run: not valid on an agent job'))
  })

  it('requires run on a script job, and rejects agent-only fields', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'script', model: 'claude-sonnet-5', prompt: 'hi' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('jobs.a.run: required for a script job'))
    assert.ok(!result.ok && result.errors.includes('jobs.a.model: not valid on a script job'))
    assert.ok(!result.ok && result.errors.includes('jobs.a.prompt: not valid on a script job'))
  })

  it('rejects a non-positive-integer max_steps', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'agent', model: 'm', prompt: 'p', max_steps: 0 } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('jobs.a.max_steps: must be a positive integer'))
  })
})

describe('validateWish — job.outputs', () => {
  it('accepts a job with no outputs at all', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, true)
  })

  it('rejects an output field missing a type', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'script', run: 'x', outputs: { field: {} } } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes("jobs.a.outputs.field: must be an object with a 'type' field"))
  })

  it('rejects an output field with an unrecognised type', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      jobs: { a: { type: 'script', run: 'x', outputs: { field: { type: 'date' } } } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.some(e => e.startsWith('jobs.a.outputs.field.type:')))
  })
})
