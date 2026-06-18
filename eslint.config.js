// Flat config (ESLint v9+). Typescript-eslint's recommended set is the
// high-value subset for a TS project: it turns off rules that duplicate the
// type-checker (no-undef, no-unused-vars-as-types) and keeps the rules types
// CAN'T check — dead code, unreachable branches, unused imports.
//
// Pair with `npm run typecheck`; lint is wired into CI.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated Flue workflows are machine-written — linting them is noise.
    // fixtures/ is a *simulated* sample repo (CommonJS) that the build/test
    // tools operate on — it's test data, not code under our standards.
    ignores: ['dist/**', 'src/workflows/gen-*.ts', 'fixtures/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
);
