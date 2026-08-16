import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // `tests/spike/fixtures/*.js` is esbuild output generated at test-run time by
  // gate3-layout-parity.spec.ts (bundling milkdown-compare.ts + all of
  // Milkdown into a ~1MB browser bundle). It's gitignored, but ESLint and
  // Prettier don't read .gitignore, so without this it fails `pnpm lint` with
  // thousands of errors for anyone who has run the Phase 1 Playwright gate
  // once. Ignored by directory glob rather than by exact filename so any
  // future similarly-generated fixture bundle is covered too.
  { ignores: ['**/node_modules', '**/dist', '**/out', 'tests/spike/fixtures/*.js'] },
  tseslint.configs.recommended,
  // Plain-JS Node bootstrap scripts loaded via `--import` before anything else
  // in a worker (currently the Vitest DOM teardown shim). They cannot carry TS
  // annotations -- Node executes them directly, with no transform -- so the two
  // TypeScript-shaped rules below are unsatisfiable rather than merely
  // inconvenient. Scoped to this one directory and extension so nothing in
  // src/ or tests/ loses them; an empty function is exactly the point of a
  // no-op shim.
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off'
    }
  },
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier
)
