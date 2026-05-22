/**
 * eslint.config.mjs — flat config (ESLint 9+).
 *
 * The interesting rules in this file are the *import boundaries*: they enforce the
 * three-layer architecture from REBUILD.md § 4. Examples of what they prevent:
 *
 *  • A `components/**` file importing `lib/db/**` (UI must not query the DB directly).
 *  • A `lib/db/**` file importing from `lib/rbac/**` (the DB layer must not know about RBAC).
 *  • A `lib/pdns/**` file importing from `lib/rbac/**` or `lib/audit/**` (PDNS client is
 *    a pure protocol adapter, RBAC and audit happen above it).
 *
 * When you find yourself wanting to disable one of these rules, that's a signal you're
 * about to break the architecture. Stop and either refactor or write an ADR explaining
 * why this case is the exception.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
// `eslint-plugin-import-x` is the actively-maintained, ESLint-10-compatible
// fork of `eslint-plugin-import` (the original crashes on ESLint 10's rule
// API). Registered under the `import` plugin key below so the existing
// `import/...` rule names and inline disable directives keep working.
import importPlugin from "eslint-plugin-import-x";
// Next's own `eslint-config-next` bundles `eslint-plugin-react`, which calls
// APIs ESLint 10 removed (`context.getFilename`) and crashes the entire lint
// run. Rather than run that brittle config, we compose the two highest-value,
// ESLint-10-compatible pieces it vendors — the React Hooks rules and the
// @next/next framework checks — directly. `eslint-config-next` stays a
// devDependency precisely because it's what installs these into node_modules.
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  // === Files to ignore globally ===
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "drizzle/meta/**",
      // Legacy reference — never lint, never modify.
      "PowerDNS-Admin/**",
      // postcss.config.mjs / eslint.config.mjs aren't in tsconfig.json's
      // `include` (which is .ts/.tsx only). The type-aware lint rules
      // need the file to be part of the TS project service to resolve
      // types; without that we get a "not found by the project
      // service" parser error. Both files are declarative config with
      // no runtime logic worth linting — skip them.
      "postcss.config.mjs",
      "eslint.config.mjs",
      "docker/entrypoint.mjs",
    ],
  },

  // === Base recommended configs ===
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // === TypeScript project setup ===
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // === Project-wide rules ===
  {
    plugins: { import: importPlugin },
    // `import/no-default-export` operates on the AST — no resolver needed. The
    // three-layer import boundary (ADR-0004) is enforced separately by
    // `no-restricted-imports` patterns in the per-layer `files` blocks below.
    // (It used to be `import/no-restricted-paths`, which silently never fired:
    // that rule needs a resolver to map the `@/` alias to a path, and none was
    // configured — see ADR-0013.)
    rules: {
      // CONTRIBUTING.md § Language: no default exports. Named exports refactor cleanly.
      "import/no-default-export": "error",

      // CONTRIBUTING.md § Errors: no silent catches.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],

      // Type safety. `any` is reserved for marked boundaries; everywhere else it's an error.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Relax `checksVoidReturn.attributes` because React internally
      // void-wraps event-handler return values — `<button onClick={async ()
      // => {…}}>` is the idiomatic pattern and not a real bug. The rule
      // still catches the dangerous cases (passing an async function
      // where a sync-void callback is *actually* required, e.g.
      // `Array.prototype.forEach`, `setTimeout`).
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],

      // Style preferences. Most are pre-commit-hook-fixable.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],

      // The three-layer import boundary (ADR-0004) lives in the per-layer
      // `files` blocks below, via `no-restricted-imports` (specifier-based).
    },
  },

  // === Import boundary: components must not reach into server-only layers ===
  // UI renders data passed in as props / from server components; it never
  // queries the DB, talks to PDNS, or touches auth internals directly.
  {
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/db", "@/lib/db/**"],
              message:
                "UI components must not import lib/db. Data goes through server components, route handlers, or domain logic.",
            },
            {
              group: ["@/lib/pdns", "@/lib/pdns/**"],
              message:
                "UI components must not import lib/pdns. PDNS access goes through server components or route handlers.",
            },
            {
              group: ["@/lib/auth", "@/lib/auth/**"],
              message:
                "UI components must not import lib/auth. Receive `currentUser` as a prop from a server component.",
            },
          ],
        },
      ],
    },
  },

  // === Import boundary: the DB layer must not know about RBAC ===
  {
    files: ["lib/db/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/rbac", "@/lib/rbac/**"],
              message:
                "lib/db must not import lib/rbac. Authorization happens above the DB layer, not inside it.",
            },
          ],
        },
      ],
    },
  },

  // === Import boundary: the PDNS client is a pure protocol adapter ===
  // RBAC, audit, DB writes, and auth happen in the calling business logic, not
  // inside the client. The four sanctioned DB-bridge files (registry,
  // request-log, cluster-picker, sync) carry a file-top disable referencing
  // ADR-0013.
  {
    files: ["lib/pdns/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/rbac",
                "@/lib/rbac/**",
                "@/lib/audit",
                "@/lib/audit/**",
                "@/lib/db",
                "@/lib/db/**",
                "@/lib/auth",
                "@/lib/auth/**",
              ],
              message:
                "lib/pdns is a pure protocol adapter (ADR-0004). RBAC/audit/DB/auth happen in the caller. If this is a deliberate DB bridge, see ADR-0013.",
            },
          ],
        },
      ],
    },
  },

  // === Exceptions for Next.js conventions ===
  // App Router files (`page.tsx`, `layout.tsx`, `route.ts`, etc.) MUST use default exports.
  // This is a framework requirement; the rule is an explicit, scoped exception.
  {
    files: [
      "app/**/page.tsx",
      "app/**/layout.tsx",
      "app/**/loading.tsx",
      "app/**/error.tsx",
      "app/**/not-found.tsx",
      "app/**/template.tsx",
      "app/**/default.tsx",
      "app/**/route.ts",
      "app/**/icon.tsx",
      "app/**/apple-icon.tsx",
      "app/**/opengraph-image.tsx",
      "app/**/twitter-image.tsx",
      "app/**/sitemap.ts",
      "app/**/robots.ts",
      "app/**/manifest.ts",
      "middleware.ts",
      "instrumentation.ts",
      "next.config.ts",
      "drizzle.config.ts",
      "playwright.config.ts",
      "vitest.config.ts",
      "vitest.config.integration.ts",
      "tailwind.config.ts",
      "postcss.config.mjs",
      "eslint.config.mjs",
      "drizzle.sqlite.config.ts",
    ],
    rules: { "import/no-default-export": "off" },
  },

  // === React Hooks rules ===
  // `rules-of-hooks` is a hard correctness invariant (error). `exhaustive-deps`
  // catches stale-closure bugs in effects/callbacks (warn — gated to a hard
  // failure by `--max-warnings=0`). From eslint-plugin-react-hooks, which —
  // unlike the bundled eslint-plugin-react — runs on ESLint 10.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // === Next.js framework checks (@next/next) ===
  // no-img-element, no-html-link-for-pages, no-sync-scripts, etc. Also
  // satisfies the existing `@next/next/no-img-element` disable directives.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "middleware.ts", "instrumentation.ts"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
);
