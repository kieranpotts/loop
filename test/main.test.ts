import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wishPath } from '../src/main.ts'

describe('wishPath', () => {
  it('resolves a name to .agents/wishes/<name>.yaml', () => {
    assert.equal(wishPath('hello'), '.agents/wishes/hello.yaml')
  })

  it('does not alter names that already look like paths', () => {
    assert.equal(wishPath('sub/name'), '.agents/wishes/sub/name.yaml')
  })
})
