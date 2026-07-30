import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { runWish } from '../src/exec.ts'
import type { Wish } from '../src/schema.ts'

describe('runWish', () => {
  it('runs steps in dependency order, threading output through templating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-exec-'))
    const file = join(dir, 'out.txt')
    try {
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: {
          consume: {
            needs: ['produce'],
            type: 'script',
            run: `printf '%s' '{{ steps.produce.outputs.message }}' > ${file}`,
          },
          produce: {
            type: 'script',
            run: 'echo \'{"message":"ok"}\'',
            outputs: { message: { type: 'string' } },
          },
        },
      }

      const outcome = runWish(wish)
      assert.equal(outcome.ok, true)
      assert.equal(readFileSync(file, 'utf8'), 'ok')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('succeeds for a step with no declared outputs (stdout streams through)', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'script', run: 'echo hi' } },
    }
    assert.equal(runWish(wish).ok, true)
  })

  it('refuses to run a wish containing a type: agent step', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'agent', model: 'm', prompt: 'p' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("step 'a': type 'agent' is not executable yet"))
  })

  it('reports a nonzero exit status', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'script', run: 'exit 7' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("step 'a': command exited with status 7"))
  })

  it('rejects non-JSON stdout when outputs are declared', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: {
        a: {
          type: 'script',
          run: 'echo not-json',
          outputs: { x: { type: 'string' } },
        },
      },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes('stdout is not valid JSON'))
  })

  it('rejects stdout missing a declared output field', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: {
        a: {
          type: 'script',
          run: 'echo \'{"other":1}\'',
          outputs: { x: { type: 'string' } },
        },
      },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("output 'x' missing from stdout"))
  })

  it('rejects stdout whose output field has the wrong type', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: {
        a: {
          type: 'script',
          run: 'echo \'{"x":123}\'',
          outputs: { x: { type: 'string' } },
        },
      },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("output 'x' does not match declared type 'string'"))
  })

  it('reports an unresolved template reference', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'script', run: 'echo {{ steps.missing.outputs.x }}' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes('unresolved template reference'))
  })
})

describe('runWish — state persistence', () => {
  it('writes no state file when state is not configured', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'script', run: 'echo hi' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, true)
    assert.ok(outcome.ok && outcome.statePath === undefined)
  })

  it('records each step\'s status and outputs, keyed by run id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-state-'))
    try {
      const wish: Wish = {
        wish: '1',
        name: 'pipeline',
        state: { path: join(dir, '{{ run.id }}', 'state.yaml') },
        steps: {
          greet: {
            type: 'script',
            run: 'echo \'{"message":"ok"}\'',
            outputs: { message: { type: 'string' } },
          },
          print: {
            needs: ['greet'],
            type: 'script',
            run: 'echo hi',
          },
        },
      }

      const outcome = runWish(wish)
      assert.equal(outcome.ok, true)
      assert.ok(outcome.ok && outcome.statePath)

      const state = parse(readFileSync((outcome as { statePath: string }).statePath, 'utf8'))
      assert.equal(state.run.wish, 'pipeline')
      assert.equal(typeof state.run.id, 'string')
      assert.deepEqual(state.steps.greet, { status: 'success', outputs: { message: 'ok' } })
      assert.deepEqual(state.steps.print, { status: 'success', outputs: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks a failed step as failed and unreached steps as pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-state-'))
    try {
      const statePath = join(dir, 'state.yaml')
      const wish: Wish = {
        wish: '1',
        name: 't',
        state: { path: statePath },
        steps: {
          a: { type: 'script', run: 'echo hi' },
          b: { needs: ['a'], type: 'script', run: 'exit 5' },
          c: { needs: ['b'], type: 'script', run: 'echo never' },
        },
      }

      const outcome = runWish(wish)
      assert.equal(outcome.ok, false)

      const state = parse(readFileSync(statePath, 'utf8'))
      assert.equal(state.steps.a.status, 'success')
      assert.equal(state.steps.b.status, 'failed')
      assert.ok(state.steps.b.error.includes('exit'))
      assert.deepEqual(state.steps.c, { status: 'pending' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates parent directories for state.path if they do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-state-'))
    try {
      const statePath = join(dir, 'nested', 'deeper', 'state.yaml')
      const wish: Wish = {
        wish: '1',
        name: 't',
        state: { path: statePath },
        steps: { a: { type: 'script', run: 'echo hi' } },
      }

      assert.equal(runWish(wish).ok, true)
      assert.ok(existsSync(statePath))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an unresolved template reference in state.path before running anything', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      state: { path: '/tmp/{{ nonsense }}/state.yaml' },
      steps: { a: { type: 'script', run: 'echo hi' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes('unresolved template reference'))
  })
})
