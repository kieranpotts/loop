#!/usr/bin/env node

// wish — runs a Loop workflow definition.
//
// Wishes are YAML files stored at .agents/wishes/<name>.yaml, relative to the
// current working directory. `wish <name>` resolves that file and, in time,
// executes it. For now it only resolves and reports the file — execution
// isn't implemented yet.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const wishesDir = '.agents/wishes'

function main(): void {
  const name = process.argv[2]

  if (process.argv.length !== 3 || !name) {
    console.error('usage: wish <name>')
    process.exit(1)
  }

  const path = join(wishesDir, `${name}.yaml`)

  if (!existsSync(path)) {
    console.error(`wish: ${path}: not found`)
    process.exit(1)
  }

  console.log(`wish: found ${path} (execution not yet implemented)`)
}

main()
