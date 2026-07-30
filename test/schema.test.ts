import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateWish } from '../src/schema.ts'

const validWish = {
  loop: '1',
  name: 'fix-and-verify',
  limits: { max_turns: 200, timeout: '45m', budget_usd: 10 },
  state: { path: '.loop/runs/{{ run.id }}/state.yaml' },
  steps: {
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
      prompt: 'Fix the failures: {{ steps.test.outputs.failures }}',
      max_steps: 20,
      until: '{{ steps.implement.outputs.tests_pass == true }}',
      outputs: { tests_pass: { type: 'boolean' } },
    },
  },
}

describe('validateWish — the MVP example from design.md', () => {
  it('accepts it as-is', () => {
    const result = validateWish(validWish)
    assert.equal(result.ok, true)
  })

  it('accepts a minimal wish with only loop, name and one script step', () => {
    const result = validateWish({
      loop: '1',
      name: 'hello',
      steps: { greet: { type: 'script', run: 'echo hi' } },
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
    const result = validateWish({ steps: { a: { type: 'script', run: 'x' } } })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.some(e => e.startsWith('loop:')))
    assert.ok(!result.ok && result.errors.some(e => e.startsWith('name:')))
  })

  it('requires steps to be a non-empty object', () => {
    const result = validateWish({ loop: '1', name: 'x', steps: {} })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('steps: required, must be a non-empty object'))
  })
})

describe('validateWish — limits', () => {
  it('rejects a non-positive-integer max_turns', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      limits: { max_turns: 0 },
      steps: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('limits.max_turns: must be a positive integer'))
  })

  it('rejects a negative budget_usd', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      limits: { budget_usd: -1 },
      steps: { a: { type: 'script', run: 'x' } },
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
      steps: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('state.path: required when state is set'))
  })
})

describe('validateWish — step.needs', () => {
  it('rejects a needs entry that names an unknown step', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { needs: ['missing'], type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes("steps.a.needs: references unknown step 'missing'"))
  })

  it('rejects a two-step cycle', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: {
        a: { needs: ['b'], type: 'script', run: 'x' },
        b: { needs: ['a'], type: 'script', run: 'x' },
      },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.some(e => e.startsWith("steps: cyclic 'needs' dependency:")))
  })

  it('accepts a diamond dependency shape (not a cycle)', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: {
        a: { type: 'script', run: 'x' },
        b: { needs: ['a'], type: 'script', run: 'x' },
        c: { needs: ['a'], type: 'script', run: 'x' },
        d: { needs: ['b', 'c'], type: 'script', run: 'x' },
      },
    })
    assert.equal(result.ok, true)
  })
})

describe('validateWish — step.type', () => {
  it('rejects an unknown step type', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'human_gate' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes("steps.a.type: must be 'agent' or 'script'"))
  })

  it('requires model and prompt on an agent step, and rejects run', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'agent', run: 'echo hi' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('steps.a.model: required for an agent step'))
    assert.ok(!result.ok && result.errors.includes('steps.a.prompt: required for an agent step'))
    assert.ok(!result.ok && result.errors.includes('steps.a.run: not valid on an agent step'))
  })

  it('requires run on a script step, and rejects agent-only fields', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'script', model: 'claude-sonnet-5', prompt: 'hi' } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('steps.a.run: required for a script step'))
    assert.ok(!result.ok && result.errors.includes('steps.a.model: not valid on a script step'))
    assert.ok(!result.ok && result.errors.includes('steps.a.prompt: not valid on a script step'))
  })

  it('rejects a non-positive-integer max_steps', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'agent', model: 'm', prompt: 'p', max_steps: 0 } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes('steps.a.max_steps: must be a positive integer'))
  })
})

describe('validateWish — step.outputs', () => {
  it('accepts a step with no outputs at all', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'script', run: 'x' } },
    })
    assert.equal(result.ok, true)
  })

  it('rejects an output field missing a type', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'script', run: 'x', outputs: { field: {} } } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.includes("steps.a.outputs.field: must be an object with a 'type' field"))
  })

  it('rejects an output field with an unrecognised type', () => {
    const result = validateWish({
      loop: '1',
      name: 'x',
      steps: { a: { type: 'script', run: 'x', outputs: { field: { type: 'date' } } } },
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.errors.some(e => e.startsWith('steps.a.outputs.field.type:')))
  })
})
