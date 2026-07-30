import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findCycle, topologicalOrder } from '../src/dag.ts'

describe('topologicalOrder', () => {
  it('orders a linear chain', () => {
    const order = topologicalOrder({
      c: { needs: ['b'] },
      b: { needs: ['a'] },
      a: {},
    })
    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  it('places a diamond\'s join after both branches', () => {
    const order = topologicalOrder({
      a: {},
      b: { needs: ['a'] },
      c: { needs: ['a'] },
      d: { needs: ['b', 'c'] },
    })
    assert.equal(order.indexOf('a'), 0)
    assert.ok(order.indexOf('d') > order.indexOf('b'))
    assert.ok(order.indexOf('d') > order.indexOf('c'))
  })

  it('breaks ties alphabetically for a deterministic order', () => {
    const order = topologicalOrder({ z: {}, a: {}, m: {} })
    assert.deepEqual(order, ['a', 'm', 'z'])
  })

  it('includes every step exactly once', () => {
    const order = topologicalOrder({
      a: {}, b: { needs: ['a'] }, c: { needs: ['a'] },
    })
    assert.deepEqual([...order].sort(), ['a', 'b', 'c'])
  })
})

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    assert.equal(findCycle({ a: {}, b: { needs: ['a'] } }), null)
  })

  it('finds a two-step cycle', () => {
    const cycle = findCycle({ a: { needs: ['b'] }, b: { needs: ['a'] } })
    assert.deepEqual(cycle, ['a', 'b', 'a'])
  })

  it('finds a longer cycle', () => {
    const cycle = findCycle({
      a: { needs: ['b'] },
      b: { needs: ['c'] },
      c: { needs: ['a'] },
    })
    assert.deepEqual(cycle, ['a', 'b', 'c', 'a'])
  })

  it('ignores a needs entry that names a step outside the graph', () => {
    assert.equal(findCycle({ a: { needs: ['missing'] } }), null)
  })
})
