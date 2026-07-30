// Graph operations on a wish's `steps`, keyed by step id and connected by
// `needs`. Both functions here trust that the graph is well-formed (every
// `needs` entry names a real step) — that's a boundary check `validateWish`
// already performs before either of these ever runs.

export interface HasNeeds {
  needs?: string[]
}

/** Depth-first search for a cycle in `needs`. Returns the cycle, if any. */
export function findCycle (steps: Record<string, HasNeeds>): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const state = new Map<string, number>()
  const stack: string[] = []

  function visit (id: string): string[] | null {
    state.set(id, GRAY)
    stack.push(id)

    for (const dep of steps[id]?.needs ?? []) {
      if (!(dep in steps)) continue // reported separately as an unknown-step error

      const depState = state.get(dep) ?? WHITE
      if (depState === GRAY) {
        const cycleStart = stack.indexOf(dep)
        return [...stack.slice(cycleStart), dep]
      }
      if (depState === WHITE) {
        const found = visit(dep)
        if (found) return found
      }
    }

    stack.pop()
    state.set(id, BLACK)
    return null
  }

  for (const id of Object.keys(steps)) {
    if ((state.get(id) ?? WHITE) === WHITE) {
      const found = visit(id)
      if (found) return found
    }
  }

  return null
}

/**
 * A valid execution order for `steps`, via Kahn's algorithm.
 *
 * Assumes an acyclic graph — call only after `findCycle` has confirmed there
 * is none. Ties are broken alphabetically so the order is deterministic.
 */
export function topologicalOrder (steps: Record<string, HasNeeds>): string[] {
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const id of Object.keys(steps)) {
    inDegree.set(id, 0)
    dependents.set(id, [])
  }

  for (const [id, step] of Object.entries(steps)) {
    for (const dep of step.needs ?? []) {
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
      dependents.get(dep)?.push(id)
    }
  }

  const ready = Object.keys(steps).filter(id => inDegree.get(id) === 0).sort()
  const order: string[] = []

  while (ready.length > 0) {
    const id = ready.shift()
    if (id === undefined) break
    order.push(id)

    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }

  return order
}
