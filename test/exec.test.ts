import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import { runWish } from '../src/exec.ts'
import type { Wish } from '../src/schema.ts'

/**
 * Writes a fake `genie` executable to `dir`, shaped like the real CLI's
 * documented contract: `-p`/`-m` flags, `--json` switching between plain text
 * and one-JSON-event-per-line output, exit code and response controllable via
 * env vars so each test can drive a different scenario.
 */
function writeFakeGenie (dir: string): void {
  const script = `#!/usr/bin/env node
const hasJson = process.argv.includes('--json')
const exitCode = Number(process.env.FAKE_GENIE_EXIT_CODE ?? '0')
const response = process.env.FAKE_GENIE_RESPONSE ?? 'ok'
const firstResponse = process.env.FAKE_GENIE_RESPONSE_FIRST
const stderrText = process.env.FAKE_GENIE_STDERR ?? ''
const delayMs = Number(process.env.FAKE_GENIE_DELAY_MS ?? '0')

if (delayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}

if (stderrText) process.stderr.write(stderrText + '\\n')

if (hasJson) {
  const messageEnd = (text) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const lines = [{ type: 'session' }, { type: 'turn_start' }]
  if (firstResponse) lines.push(messageEnd(firstResponse))
  lines.push(messageEnd(response), { type: 'agent_end' })
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n')
} else {
  process.stdout.write(response)
}

process.exit(exitCode)
`
  const path = join(dir, 'genie')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

/** Runs `fn` with `dir` prepended to PATH, restoring it afterwards. */
function withPrependedPath<T> (dir: string, fn: () => T): T {
  const original = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${original ?? ''}`
  try {
    return fn()
  } finally {
    process.env.PATH = original
  }
}

/** Runs `fn` with PATH cleared, so no `genie` can possibly be found on it. */
function withNoPath<T> (fn: () => T): T {
  const original = process.env.PATH
  process.env.PATH = ''
  try {
    return fn()
  } finally {
    process.env.PATH = original
  }
}

describe('runWish', () => {
  it('runs steps in document order, threading output through templating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-exec-'))
    const file = join(dir, 'out.txt')
    try {
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: {
          produce: {
            type: 'script',
            run: 'echo \'{"message":"ok"}\'',
            outputs: { message: { type: 'string' } },
          },
          consume: {
            type: 'script',
            run: `printf '%s' '{{ steps.produce.outputs.message }}' > ${file}`,
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

describe('runWish — agent steps', () => {
  it('runs a single-shot agent step and captures declared outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p', outputs: { answer: { type: 'string' } } } },
      }
      const outcome = withPrependedPath(dir, () => {
        process.env.FAKE_GENIE_RESPONSE = '{"answer":"42"}'
        return runWish(wish)
      })
      assert.equal(outcome.ok, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('succeeds for an agent step with no declared outputs (response streams through)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p' } },
      }
      const outcome = withPrependedPath(dir, () => runWish(wish))
      assert.equal(outcome.ok, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts the LAST assistant message_end, not the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p', outputs: { answer: { type: 'string' } } } },
      }
      const outcome = withPrependedPath(dir, () => {
        process.env.FAKE_GENIE_RESPONSE_FIRST = '{"answer":"wrong"}'
        process.env.FAKE_GENIE_RESPONSE = '{"answer":"right"}'
        return runWish(wish)
      })
      assert.equal(outcome.ok, true)
    } finally {
      delete process.env.FAKE_GENIE_RESPONSE_FIRST
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports genie\'s nonzero exit status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p' } },
      }
      const outcome = withPrependedPath(dir, () => {
        process.env.FAKE_GENIE_EXIT_CODE = '3'
        return runWish(wish)
      })
      assert.equal(outcome.ok, false)
      assert.ok(!outcome.ok && outcome.error.includes("step 'a': genie exited with status 3"))
    } finally {
      delete process.env.FAKE_GENIE_EXIT_CODE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a response that does not match declared outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p', outputs: { answer: { type: 'string' } } } },
      }
      const outcome = withPrependedPath(dir, () => {
        process.env.FAKE_GENIE_RESPONSE = 'not json'
        return runWish(wish)
      })
      assert.equal(outcome.ok, false)
      assert.ok(!outcome.ok && outcome.error.includes("the agent's response is not valid JSON"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a clear error when genie is not on PATH', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p' } },
    }
    const outcome = withNoPath(() => runWish(wish))
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes('genie not found on PATH'))
  })

  it('refuses a step that declares until', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'agent', model: 'm', prompt: 'p', until: '{{ steps.a.outputs.done }}' } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("'until'/'max_steps' need internal iteration"))
  })

  it('refuses a step that declares max_steps', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'agent', model: 'm', prompt: 'p', max_steps: 5 } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("'until'/'max_steps' need internal iteration"))
  })

  it('refuses a step that declares non-empty tools', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: { a: { type: 'agent', model: 'm', prompt: 'p', tools: ['shell'] } },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("'tools' isn't supported yet"))
  })

  it('does not refuse a step that declares an empty tools list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: { a: { type: 'agent', model: 'm', prompt: 'p', tools: [] } },
      }
      const outcome = withPrependedPath(dir, () => runWish(wish))
      assert.equal(outcome.ok, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
          b: { type: 'script', run: 'exit 5' },
          c: { type: 'script', run: 'echo never' },
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

describe('runWish — limits', () => {
  it('stops after limits.max_turns steps, leaving the rest pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-limits-'))
    try {
      const statePath = join(dir, 'state.yaml')
      const wish: Wish = {
        wish: '1',
        name: 't',
        limits: { max_turns: 2 },
        state: { path: statePath },
        steps: {
          a: { type: 'script', run: 'echo a' },
          b: { type: 'script', run: 'echo b' },
          c: { type: 'script', run: 'echo c' },
        },
      }

      const outcome = runWish(wish)
      assert.equal(outcome.ok, false)
      assert.ok(!outcome.ok && outcome.error.includes("limits.max_turns (2) reached before step 'c' could run"))

      const state = parse(readFileSync(statePath, 'utf8'))
      assert.equal(state.steps.a.status, 'success')
      assert.equal(state.steps.b.status, 'success')
      assert.deepEqual(state.steps.c, { status: 'pending' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs normally when max_turns is not exceeded', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      limits: { max_turns: 10 },
      steps: { a: { type: 'script', run: 'echo hi' } },
    }
    assert.equal(runWish(wish).ok, true)
  })

  it('kills a script step that exceeds limits.timeout', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      limits: { timeout: '150ms' },
      steps: { a: { type: 'script', run: 'sleep 2' } },
    }
    const start = Date.now()
    const outcome = runWish(wish)
    const elapsed = Date.now() - start

    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("step 'a': timed out after"))
    assert.ok(!outcome.ok && outcome.error.includes('limits.timeout'))
    assert.ok(elapsed < 1000, `expected the step to be killed well before 2s, took ${elapsed}ms`)
  })

  it('kills an agent step that exceeds limits.timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-'))
    try {
      writeFakeGenie(dir)
      const wish: Wish = {
        wish: '1',
        name: 't',
        limits: { timeout: '150ms' },
        steps: { a: { type: 'agent', model: 'computer-programmer', prompt: 'p' } },
      }
      const outcome = withPrependedPath(dir, () => {
        process.env.FAKE_GENIE_DELAY_MS = '2000'
        return runWish(wish)
      })
      assert.equal(outcome.ok, false)
      assert.ok(!outcome.ok && outcome.error.includes("step 'a': timed out after"))
    } finally {
      delete process.env.FAKE_GENIE_DELAY_MS
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs normally when timeout is not exceeded', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      limits: { timeout: '30s' },
      steps: { a: { type: 'script', run: 'echo hi' } },
    }
    assert.equal(runWish(wish).ok, true)
  })
})

describe('runWish — retry', () => {
  it('retries a failing step and succeeds once a later attempt passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-retry-'))
    const marker = join(dir, 'ran-once')
    try {
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: {
          check: {
            type: 'script',
            run: `test -f ${marker} && exit 0 || (touch ${marker} && exit 1)`,
            retry: { max_attempts: 2, rerun: ['check'] },
          },
        },
      }
      assert.equal(runWish(wish).ok, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives up after max_attempts and reports the last attempt\'s error', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      steps: {
        check: {
          type: 'script',
          run: 'exit 9',
          retry: { max_attempts: 3, rerun: ['check'] },
        },
      },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes("step 'check': command exited with status 9"))
  })

  it('reruns every step named in retry.rerun, in order, on each attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-retry-'))
    const log = join(dir, 'log')
    try {
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: {
          a: { type: 'script', run: `echo a >> ${log}` },
          b: {
            type: 'script',
            run: `echo b >> ${log}; exit 1`,
            retry: { max_attempts: 2, rerun: ['a', 'b'] },
          },
        },
      }
      const outcome = runWish(wish)
      assert.equal(outcome.ok, false)
      assert.equal(readFileSync(log, 'utf8'), 'a\nb\na\nb\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops a retry attempt early if an earlier rerun step fails, without running the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-retry-'))
    const log = join(dir, 'log')
    const marker = join(dir, 'fixer-ran-once')
    try {
      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: {
          // Succeeds the first time (the main pass), fails every time after
          // (any retry attempt) — so 'check' failing forces a retry, and the
          // retry's own rerun of 'fixer' then fails too.
          fixer: {
            type: 'script',
            run: `echo fixer >> ${log}; test -f ${marker} && exit 1 || (touch ${marker} && exit 0)`,
          },
          check: {
            type: 'script',
            run: `echo check >> ${log}; exit 1`,
            retry: { max_attempts: 2, rerun: ['fixer', 'check'] },
          },
        },
      }
      const outcome = runWish(wish)
      assert.equal(outcome.ok, false)
      // Main pass: fixer (succeeds), check (fails). Retry attempt 2 reruns
      // fixer, which now fails, so 'check' is never reached a second time.
      assert.equal(readFileSync(log, 'utf8'), 'fixer\ncheck\nfixer\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records the final success in state after a retry recovers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-retry-'))
    const marker = join(dir, 'ran-once')
    const statePath = join(dir, 'state.yaml')
    try {
      const wish: Wish = {
        wish: '1',
        name: 't',
        state: { path: statePath },
        steps: {
          check: {
            type: 'script',
            run: `test -f ${marker} && exit 0 || (touch ${marker} && exit 1)`,
            retry: { max_attempts: 2, rerun: ['check'] },
          },
        },
      }
      const outcome = runWish(wish)
      assert.equal(outcome.ok, true)
      const state = parse(readFileSync(statePath, 'utf8'))
      assert.equal(state.steps.check.status, 'success')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts immediately if limits.max_turns is reached during a retry, without exhausting max_attempts', () => {
    const wish: Wish = {
      wish: '1',
      name: 't',
      limits: { max_turns: 2 },
      steps: {
        check: {
          type: 'script',
          run: 'exit 1',
          retry: { max_attempts: 10, rerun: ['check'] },
        },
      },
    }
    const outcome = runWish(wish)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok && outcome.error.includes('limits.max_turns (2) reached'))
  })

  it('retries a failing agent step and succeeds once a later attempt passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wish-genie-retry-'))
    const marker = join(dir, 'ran-once')
    try {
      const script = `#!/usr/bin/env node
const fs = require('node:fs')
if (fs.existsSync('${marker}')) {
  process.stdout.write('ok')
  process.exit(0)
} else {
  fs.writeFileSync('${marker}', '')
  process.exit(1)
}
`
      const geniePath = join(dir, 'genie')
      writeFileSync(geniePath, script)
      chmodSync(geniePath, 0o755)

      const wish: Wish = {
        wish: '1',
        name: 't',
        steps: {
          ask: {
            type: 'agent',
            model: 'computer-programmer',
            prompt: 'p',
            retry: { max_attempts: 2, rerun: ['ask'] },
          },
        },
      }
      const outcome = withPrependedPath(dir, () => runWish(wish))
      assert.equal(outcome.ok, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
