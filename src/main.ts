#!/usr/bin/env node

// wish — runs a Loop workflow definition.
//
// Wishes are YAML files stored at .agents/wishes/<name>.yaml, relative to the
// current working directory. `wish <name>` resolves, validates, and runs
// that file. Only `type: script` jobs execute so far — see exec.ts.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { validateWish } from './schema.ts'
import { runWish } from './exec.ts'

const wishesDir = '.agents/wishes'

/** The path a wish name resolves to, relative to the current working directory. */
export function wishPath (name: string): string {
  return join(wishesDir, `${name}.yaml`)
}

function main (): void {
  const name = process.argv[2]

  if (process.argv.length !== 3 || !name) {
    console.error('usage: wish <name>')
    process.exit(1)
  }

  const path = wishPath(name)

  if (!existsSync(path)) {
    console.error(`wish: ${path}: not found`)
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`wish: ${path}: invalid YAML: ${(error as Error).message}`)
    process.exit(1)
  }

  const result = validateWish(parsed)
  if (!result.ok) {
    console.error(`wish: ${path}: invalid wish:`)
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }

  const outcome = runWish(result.wish)
  if (!outcome.ok) {
    console.error(`wish: ${path}: ${outcome.error}`)
    process.exit(1)
  }

  console.log(`wish: ${path}: done`)
}

// Only run when executed directly, e.g. `wish hello` — not when imported by
// the test suite. `realpathSync` matters here: the installed `wish` command is
// a symlink (see run/install), and Node resolves symlinks when reporting
// `import.meta.url` for the module it loaded but NOT when populating
// `process.argv[1]`, so a plain string comparison never matches through it.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main()
}
