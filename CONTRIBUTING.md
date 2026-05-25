# Contributing

> **Why this document exists.** Multi-contributor projects accumulate a class of bug where "seemingly
> simple changes break multiple features" when there are no shared standards for boundaries, validation,
> auth, and audit. The rules below exist to prevent that class. They are short on purpose. Read them
> before opening a PR.

---

## Ground rules

1. **Every change is reviewed.** No direct pushes to `main`. PR + at least one approval. Security-sensitive
   areas (auth, RBAC, crypto, PDNS client) require two approvals.
2. **Every PR closes or links an issue.** "I had a free afternoon" is not a reason to refactor working code.
3. **Every PR ships its own tests and docs.** Bug fixes ship a regression test. Features ship docs.
4. **Trunk-based.** Short-lived branches, squash-merge to `main`, no long-running feature branches.
5. **Conventional Commits** for PR titles: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`,
   `perf:`, `build:`, `ci:`. The PR body is the changelog entry — write it for humans.

---

## Code standards

### Language and types

- **TypeScript strict mode.** `strict: true`, `noUncheckedIndexedAccess: true`. No `any` except at
  documented boundaries (e.g., parsing an external JSON blob — and even then, narrow with Zod immediately).
- **No default exports.** Named exports only. They refactor cleanly, surface better in IDEs, and avoid the
  "rename on import" footgun.
- **No abbreviations** in identifiers. `zoneRepository`, not `zoneRepo`. `permissions`, not `perms`. The
  exceptions are universally understood acronyms (`url`, `id`, `dns`, `api`).
- **Files** are `kebab-case.ts`. **Types and components** are `PascalCase`. **Functions and variables** are
  `camelCase`. **Constants** are `SCREAMING_SNAKE_CASE` only when they are truly module-level immutables.
- **Pure functions where possible.** If a function has side effects, its name should make that obvious
  (`createZone`, not `zone`).
- **No magic numbers or strings.** Name them. `const MAX_ZONE_RRSETS = 10_000` beats `if (count > 10000)`.

### Boundaries

These are the hard rules. Breaking them is what makes a codebase brittle at scale.

- **Inputs are validated at every boundary.** HTTP request body, query string, env var, third-party
  response — all of it goes through a [Zod][zod] schema. Past the boundary, you have typed data and you
  trust it.
- **Secrets only from environment variables**, parsed at boot via a single Zod schema in `lib/env.ts`. The
  app refuses to start if anything required is missing. No `process.env.FOO` reads scattered through the
  code.
- **All PowerDNS calls go through `lib/pdns/client.ts`.** No ad-hoc `fetch` to the PDNS API anywhere else.
  This is the only way to keep retries, telemetry, version detection, and error normalization in one place.
- **Server-only code is marked.** Modules that touch secrets, the database, or PDNS get
  `import "server-only"` at the top. This makes Next.js fail the build if a client component imports them.
- **No external CDN, Google Fonts, or Gravatar.** Every static asset ships with the app. Air-gapped
  enterprises are a first-class deployment target.
- **Audit-log every state-changing operation.** If it modifies a zone, a user, a permission, or a setting,
  it writes an audit row. The audit log is append-only.

[zod]: https://zod.dev

### Project layout

The shape is enforced by ESLint import rules; a PR that puts a database query inside a React component
will fail CI.

```
app/         Next.js routes (pages, layouts, route handlers). Thin — orchestration only.
lib/         Domain code. Pure where possible. The brain of the app.
  auth/      Sessions, providers, MFA. Marked server-only.
  rbac/      CASL ability definitions and policy checks.
  pdns/      Typed PowerDNS HTTP client + helpers.
  db/        Drizzle schema, migrations, repositories.
  audit/     Append-only audit log.
  env.ts     Single boot-time env validation.
components/  React components. No data fetching, no secrets.
  ui/        Generic primitives (button, input, dialog).
  domain/    Feature-specific (zone editor, record table).
drizzle/     SQL migrations (generated, hand-edited only when necessary).
tests/       Integration + e2e. Unit tests live next to the source file.
docs/        Long-form docs, ADRs, runbooks.
```

### Errors

- **Errors are values, not strings.** Throw typed errors from `lib/errors.ts` (`NotFoundError`,
  `ForbiddenError`, `ConflictError`, `ValidationError`). The HTTP layer maps them to status codes once,
  in one place.
- **No silent catches.** If you catch an error, you either re-throw, transform it, or log it with full
  context. `catch (e) {}` is a CI failure.
- **No error messages with secrets in them.** Especially the PDNS API key. Use `lib/errors/redact.ts`.

---

## Documentation standards

Documentation rots if it isn't part of the work. These rules make it part of the work.

### File-level comments

Every non-trivial module (every file in `lib/`, every route handler) starts with a short comment
explaining **what it does and why it exists**. Not what each line does — that's what the code is for.

```ts
/**
 * lib/pdns/client.ts
 *
 * Single typed HTTP client for the PowerDNS Authoritative API. All PDNS access in
 * the app goes through this module so retries, version detection, error normalization,
 * and telemetry happen in exactly one place.
 *
 * The PDNS API key is god-mode (no per-zone scoping); RBAC is enforced *above* this
 * client, never inside it. See docs/adr/0003-pdns-trust-boundary.md.
 */
```

### Function comments (JSDoc)

Every **exported** function gets JSDoc with:

- A one-line summary.
- `@param` for each parameter where the name isn't self-explanatory.
- `@returns` when the return shape matters.
- `@throws` for the error types it can throw.
- `@example` for anything non-obvious.

Internal helpers don't need JSDoc unless the behavior is surprising.

```ts
/**
 * Apply an RRset change to a zone using EXTEND/PRUNE semantics where supported,
 * falling back to REPLACE on PDNS < 4.9.12. Safe to call concurrently from two
 * sessions editing different records of the same RRset.
 *
 * @throws {ConflictError} if the zone's `edited_serial` changed since `expectedSerial`.
 * @throws {PdnsError} on any non-2xx response from PDNS.
 */
export async function applyRRsetChange(/* ... */) {
  /* ... */
}
```

### Inline comments

The rule: **comment the _why_, not the _what_.**

- ✅ `// Trailing dot is canonical at the PDNS API layer (see docs/adr/0004-naming).`
- ❌ `// Append a dot to the zone name.`

If a comment is just narrating the next line of code, delete it.

### ADRs (Architecture Decision Records)

Any decision worth preserving — choice of library, change of architectural pattern, deprecation —
gets an ADR in `docs/adr/`. Numbered, dated, never edited after merge (write a follow-up ADR instead).
Template in `docs/adr/0000-template.md`. Keep them short — one page or less.

### Per-directory READMEs

Every top-level directory in `lib/` and `components/` has a `README.md` explaining what lives there
and what doesn't. New contributors should be able to find their way without asking.

---

## Testing

Two layers, run independently:

- **Unit tests** — live next to the source (`foo.ts` + `foo.test.ts`). Pure functions, mock-free
  where reasonable, no external dependencies. Run with `npm run test`. Fast, hermetic, no
  Docker required.
- **Integration tests** — live under `tests/integration/`. They talk to a real running
  PowerDNS-AuthAdmin app + a real Postgres + real PDNS Authoritative backends across all three
  topologies (multi-primary cluster, standalone, primary+secondaries). Pure HTTP from the test
  process — tests do NOT import `lib/*`. Run with `npm run test:integration`.
- **Coverage is not a goal.** Cover the things that _matter_ — auth, RBAC, PDNS client, audit
  log, anything that handles money or secrets. Don't write tests to inflate the percentage.
- **Every bug fix ships a test that fails before the fix.** No exceptions.

### Before you push (run CI locally)

Standard pre-push gate, in order — fix anything that fails before pushing:

1. `npm run validate` — lint + typecheck + format check + unit tests.
2. `npm run test:integration` — if you touched routes, repositories, or auth.
3. **[`act`](https://github.com/nektos/act)** — run the GitHub Actions jobs in Docker to catch
   CI failures locally:

   ```sh
   act -j static-checks -W .github/workflows/ci.yml --container-architecture linux/amd64
   act -j test          -W .github/workflows/ci.yml --container-architecture linux/amd64
   ```

   `act` covers the JS-action jobs (`static-checks`, `test`, `audit`) and runs `eslint .` without
   the host-memory limits you can hit locally. It does **not** replace GitHub-hosted CodeQL, the
   Docker build/publish, Scorecard, or dependency-review — those need GitHub runners/tokens and
   remain the authority on the PR.

### Running the integration suite

`npm run test:integration` is one command. It:

1. Stops any other `powerdns-authadmin-*` compose project (they'd hold the same host ports).
2. Builds + boots the test stack (`docker-compose-combined.yml` + `tests/integration/docker-compose.test.yml`,
   project name `powerdns-authadmin-test`) and `--wait`s for every container healthy.
3. Runs vitest with `vitest.config.integration.ts`.
4. Tears the stack down. Set `KEEP_STACK=1` to keep it running between iterations.

For iterating on a single file while the stack is already up:

```sh
KEEP_STACK=1 npm run test:integration tests/integration/zones/crud.test.ts
# then for re-runs without bringing the stack down/up:
TEST_APP_URL=http://localhost:3000 \
TEST_DATABASE_URL=postgres://pdns:pdns@localhost:5432/powerdns_authadmin \
TEST_BOOTSTRAP_EMAIL=admin@test.local \
TEST_BOOTSTRAP_PASSWORD=test-bootstrap-pw-changeme-now \
  npm run test:integration:bare tests/integration/zones/crud.test.ts
```

### Integration-test contract

The harness lives under `tests/integration/helpers/`:

- `http.ts` — `TestHttp` class. Holds the cookie jar across requests and auto-injects
  `x-csrf-token` from the `pda_csrf` cookie on mutating methods (mirrors the real
  `lib/client/api-fetch.ts`).
- `auth.ts` — `loginAsBootstrap()`, `loginAs(email, password)`, `createUser(admin, attrs)`,
  `uniqueEmail()`, the `SYSTEM_ROLES` slug constants.
- `db.ts` — `dbQuery(sql, params)` and `withDb(fn)` for direct Postgres reads (useful for
  asserting state the API doesn't expose, e.g. raw audit rows).
- `pdns.ts` — `PDNS_BACKENDS` list of all 8 backends across the 3 topologies, plus
  `listZones / getZone / deleteZone / wipeAllZones` for verifying what the app under test
  actually wrote into PDNS.
- `reset.ts` — `resetState({ skipPdns?, skipDb? })` — wipes user data + (optionally) PDNS
  zones. System seed data (roles, settings, pdns_servers, oidc_providers, zone_templates,
  bootstrap admin + its super-admin role assignment) is preserved.

Every test file follows this shape:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap, createUser, uniqueEmail, SYSTEM_ROLES } from "../helpers/auth";
import { resetState } from "../helpers/reset";

describe("POST /api/admin/teams", () => {
  beforeEach(() => resetState({ skipPdns: true }));

  it("creates a team", async () => {
    const admin = await loginAsBootstrap();
    const team = await admin.sendJson<{ id: string }>("POST", "/api/admin/teams", {
      name: "Network Ops",
      slug: "network-ops",
    });
    expect(team.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

Conventions:

- **Pure HTTP, no `lib/*` imports.** Tests exercise the real running app, not in-process
  TypeScript — that's what "integration" means here.
- **`beforeEach(() => resetState(...))`** every file. Skip the PDNS wipe (`skipPdns: true`)
  for non-zone tests; it's the slow part.
- **Verify in PDNS, not just the app.** A test that creates a zone and only asks the app
  whether it succeeded proves nothing. Use the helpers in `pdns.ts` to confirm the change
  landed in the backend.
- **Wall-clock tolerance windows** over time-freezing for `now()`-based assertions. ±100ms.
- **Audit log column is `ts`** (not `occurred_at`). Action vocabulary in `lib/audit/actions.ts`.

### Per-RR-type validator template

The editor's record-content validators live in `lib/validators/rr-types/`. Currently typed:
A, AAAA, CAA, CNAME, DNAME, DS, HTTPS, MX, NAPTR, NS, OPENPGPKEY, PTR, SMIMEA, SRV, SSHFP, SVCB,
TLSA, TXT, URI (18 registered types across 17 files — `svcb.ts` holds both SVCB and HTTPS since
RFC 9460 § 7 makes them wire-format-identical). Anything else falls through to a generic validator
that warns about missing type-aware checks. Pick the canonical reference closest to your new
type's shape:

- **Numeric tags + hex payload** (DS, SSHFP, TLSA, SMIMEA) — copy `ds.ts` or `tlsa.ts`.
- **Numeric tags + hostname** (SRV, MX) — copy `srv.ts`.
- **Hostname only** (CNAME, DNAME, NS, PTR) — copy `cname.ts`; delegate the hostname
  check to `validateHostname` from `./hostname`.
- **Quoted-string fields** (CAA, NAPTR, URI) — `caa.ts` is simplest; `naptr.ts` shows a
  custom tokenizer for multi-quoted-field grammars.
- **Single base64 / binary blob** (OPENPGPKEY) — copy `openpgpkey.ts`.
- **Priority + target + `key=value` SvcParams** (SVCB, HTTPS) — copy `svcb.ts`. Pattern:
  a `KNOWN_PARAMS` map keyed by SvcParamKey name, mapped to a value-shape tag
  (`"comma-list" | "uint16" | "boolean" | "base64" | "string"`); a single `switch (shape)`
  enforces per-shape constraints. Unknown SvcParamKeys soft-warn rather than error
  (the IANA registry can grow; private-use range exists per RFC 9460 § 14.3.2).
- **Wire format identical to an already-typed sibling** — delegate. Two canonical
  precedents: `smimeaValidator.validate = (content) => tlsaValidator.validate(content)`
  (SMIMEA ≡ TLSA per RFC 8162), and `httpsValidator` / `svcbValidator` both pointing at
  the same `validateImpl` closure in `svcb.ts` (HTTPS ≡ SVCB per RFC 9460 § 7).
  Override only the identity fields (type/label/rfc/placeholder). Wrap in an arrow to
  satisfy `@typescript-eslint/unbound-method`.

Each validator file exports a single `RRTypeValidator` (from `./types`) with:

- `type` — uppercase RR mnemonic as PDNS expects it (`"DS"`, `"SSHFP"`, …).
- `label` / `description` / `placeholder` — operator-facing copy for the editor.
- `rfc` — comma-separated citations; dev tooltip shows them.
- `validate(content)` — returns `{ issues, normalized }`. `issues` is a list of
  `{ level: "error" | "warning", message }`; `normalized` is the canonical form the row
  will be saved as.

Three rules the existing validators follow uniformly — keep them:

- **Soft-warn over hard-error for known-deprecated options.** DS digest-type 1 (SHA-1),
  SSHFP algorithm 2 (DSA), TLSA matching-type 0 with suspiciously-short cert-data, URI
  target without a scheme, NAPTR flag outside `{S,A,U,P}`, SVCB/HTTPS unknown SvcParamKey,
  SVCB/HTTPS boolean key carrying a value (e.g. `no-default-alpn=1`) — all are
  technically legal or operationally-justifiable. Operators sometimes need to round-trip
  an older record; warning lets them save; error would block migrations.
- **Hard-error only for shape and range violations.** Wrong token count, non-numeric where
  an integer is required, out-of-range uint8/uint16, wrong hex length for a known
  digest-type, unbalanced quotes, unparseable JSON envelope — these can't be the
  operator's intent.
- **Whitespace-tolerant for hex/base64 payloads.** Operators copy DS/SSHFP/TLSA from
  registrar portals + `ssh-keygen` output (8-char-group hex spacing), and OPENPGPKEY
  from `gpg --export | base64` (default 76-col wrap or `-w0` no-wrap). Strip whitespace
  before length-checking; normalize to contiguous lowercase hex / compact base64 in the
  output.

Register the validator in `lib/validators/rr-types/index.ts` (add to the `REGISTRY` map and
the `SUPPORTED_TYPES` dropdown list), then add a `describe("XYZ validator")` block to
`lib/validators/rr-types/validators.test.ts`. Cover at minimum: canonical accepted case,
shape-violation rejected case, each soft-warn path, and the whitespace-normalization test
when the payload is hex or base64. If you swap the type used by the existing
`registry > returns a generic fallback for unknown types` test (e.g. you're implementing
the type it currently points at), update that test in the same change — leaving it pointing
at a registered type makes it pass meaninglessly.

Template-literal gotcha (T-134): when constructing error messages, use single quotes for
inline symbols (`'='` not `` `=` ``). Prettier may rewrite the latter into invalid TypeScript
because the inline backticks terminate the template.

---

## Security practices

- **Dependencies are managed by Renovate.** Weekly PRs, batched, with security advisories auto-merging
  if CI passes.
- **`npm audit --omit=dev` runs in CI** and blocks high/critical findings.
- **Auth code requires two reviewers**, one of whom is a maintainer.
- **Threat-modeling is mandatory** for any change to auth, RBAC, session handling, the PDNS client,
  or the public API surface. Write a short paragraph in the PR description: what could go wrong, what
  prevents it.
- **CSP is enforced** via headers; we don't tolerate inline scripts. Use nonces if you absolutely must.
- **Rate limiting on login + token endpoints** is non-negotiable.
- **Secrets in environment variables only.** Never in git, never in logs. Logs go through a redactor
  that strips known-secret patterns.

---

## Accessibility and i18n

- **WCAG 2.1 AA is the target.** Keyboard navigation works everywhere. Forms have labels. Color is
  never the only signal.
- **All user-visible strings go through i18n from day one.** No `<p>Welcome</p>` — `<p>{t('welcome')}</p>`.
  Retrofitting i18n later is a nightmare we're not signing up for.
- **`react-aria` / Radix primitives** are preferred over hand-rolled focus management.

---

## Dependencies

- **Justify every new dependency** in the PR description: what does it give us that a small amount of
  hand-written code wouldn't? Dependency sprawl is the easiest way for a codebase to become un-upgradable.
- **Prefer small, single-purpose packages** over framework-y ones. We'd rather depend on `ldapts` than on
  a 50-package "auth platform."
- **The lockfile is the source of truth.** `npm ci` (not `npm install`) in CI and Docker.

---

## Performance budgets

Numbers, not vibes.

- **Zone-list page**: First Contentful Paint under 1.5s on a 1000-zone backend, no LCP regressions on
  10,000-zone backends. Server-side pagination from PDNS' `search-data` where available.
- **Zone editor**: the record table is **paginated** (via `<DataTable>`), so at most one page
  (≤100 rows) is in the DOM regardless of zone size — large zones stay responsive without
  windowing. Initial render under 2s.
- **API endpoints**: p95 under 300ms for read endpoints, under 800ms for write endpoints, measured
  excluding the upstream PDNS round-trip.
- **Docker image**: under 250MB compressed.

These are targets. They are verified by hand for now — there is no automated performance-test gate
in CI yet.

---

## How to set up a dev environment

See [`docs/dev-setup.md`](./docs/dev-setup.md).

---

## How to propose a feature

1. Open an issue with the `proposal` label. Use the template.
2. Wait for a maintainer to ack the direction before writing code. PRs without an accepted
   proposal land in review purgatory.
3. Once accepted, draft an ADR if the change is architectural. Otherwise, open the PR.
4. PRs without an associated issue or proposal will be closed.

---

## Governance, for now

The project is small. One maintainer with final say. As the community grows, this will become a
written governance model — code-owners files, RFC process, vote thresholds. For now, the rule is:
**maintainer decides, but disagreement is welcome in writing**, not in revert wars.

The project is licensed under the **MIT License**. By submitting a contribution you agree it's
licensed under the same terms — free for anyone to copy, modify, distribute, or sell.
