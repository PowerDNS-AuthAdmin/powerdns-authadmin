/**
 * tests/noop-module.ts
 *
 * Empty stand-in that `vitest.config.ts` aliases `server-only` and
 * `client-only` to. Both packages exist only to fail the build when imported
 * from the wrong React environment; under test there is no RSC/client split,
 * so importing them should be a harmless no-op. Aliasing here is more robust
 * than relying on the `react-server` export condition, which the React Vite
 * plugin overrides.
 */
export {};
