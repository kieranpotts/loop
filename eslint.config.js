/*
 * NOTE: ESLint is pinned to v9 in package.json because neostandard (currently
 * 0.13.0, the latest release) only declares peer support for `eslint@^9.0.0`.
 * Bump ESLint to v10 once neostandard publishes a release that supports it.
 */
import neostandard from 'neostandard'

/*
 * wish is authored in TypeScript under `src/` and runs directly under Node
 * (no build step), so enable neostandard's TypeScript rules and expose the
 * Node globals everywhere. `node_modules/` is ignored by ESLint automatically.
 */
export default neostandard({
  ts: true,
  env: ['node'],
})
