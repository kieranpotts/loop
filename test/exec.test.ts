import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runWish } from '../src/exec.ts'
import type { Wish } from '../src/schema.ts'

describe('runWish', () => {
  it('runs jobs in dependency order, threading output through templating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-exec-'))
    const file = join(dir, 'out.txt')
    try {
      const wish: Wish = {
        loop: '1',
        name: 't',
        jobs: {
          consume: {
            needs: ['produce'],
            type: 'script',
            run: `printf '%s' '{{ jobs.produce.outputs.message }}' > ${file}`,
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

  it('succeeds for a job with no declared outputs (stdout streams through)', () => {
    const wish: Wish = {
      loop: '1',
      name: 't',
      jobs: { a: { type: 'script', run: 'echo hi' } },
    }
    assert.equal(runWish(wish).ok, true)
  })

  it('refuses to run a wish containing a type: agent job', () => {
    const wish: Wish = {
      loop: '1',
      name: 't',
      jobs: { a: { type: 'agent', model: 'm', prompt: 'p' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("job 'a': type 'agent' is not executable yet"))
  })

  it('reports a nonzero exit status', () => {
    const wish: Wish = {
      loop: '1',
      name: 't',
      jobs: { a: { type: 'script', run: 'exit 7' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("job 'a': command exited with status 7"))
  })

  it('rejects non-JSON stdout when outputs are declared', () => {
    const wish: Wish = {
      loop: '1',
      name: 't',
      jobs: {
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
      loop: '1',
      name: 't',
      jobs: {
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
      loop: '1',
      name: 't',
      jobs: {
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
      loop: '1',
      name: 't',
      jobs: { a: { type: 'script', run: 'echo {{ jobs.missing.outputs.x }}' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes('unresolved template reference'))
  })
})
