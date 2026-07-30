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
