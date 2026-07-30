// Parses a workflow duration string like "45m", "10s", "500ms", or "2h" into
// milliseconds. Shared between schema validation (is the string well-formed?)
// and execution (how many milliseconds does it actually mean?).

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

export function parseDuration (text: string): number | null {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text)
  if (!match) return null

  const [, digits, unit] = match
  if (!digits || !unit) return null

  return Number(digits) * UNITS[unit]!
}
