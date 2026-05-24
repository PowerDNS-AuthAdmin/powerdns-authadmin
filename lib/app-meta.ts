/**
 * lib/app-meta.ts
 *
 * App identity surfaced in the UI — running version + canonical links.
 * package.json is the single source of truth for the semver, so cutting a
 * release only has to bump one file.
 *
 * For builds cut from a COMMIT rather than a release tag (anything on `main`
 * past the last tag), the container build injects the commit SHA (see the
 * Dockerfile `runner` stage + the CI docker job). We then surface
 * `version+<sha>` and links that point at that exact commit, so the sidebar
 * never claims to be a release it isn't and the GitHub/Docs links resolve to
 * the code that's actually running rather than a stale tag.
 *
 * Server-only: keeps package.json (scripts, the full dependency tree) out of
 * any client bundle, and reads the build env (APP_GIT_SHA / APP_RELEASE) at
 * runtime on the server.
 */

import "server-only";
import pkg from "@/package.json";

/** Short commit SHA baked into the image at build time, or null in local dev. */
const rawSha = process.env["APP_GIT_SHA"]?.trim();
const shortSha = rawSha ? rawSha.slice(0, 7) : null;

/**
 * True for an image built from a `vX.Y.Z` tag (CI sets `APP_RELEASE=true`) or
 * when there's no VCS info at all (local dev / a plain `docker build`) — in
 * both cases we link to the tagged release + docs rather than inventing a
 * commit ref. False only for a non-release image that carries a commit SHA.
 */
export const IS_RELEASE_BUILD: boolean = process.env["APP_RELEASE"] === "true" || shortSha === null;

/** Semver of the running build, e.g. "1.1.0". */
export const APP_VERSION: string = pkg.version;

/** Short commit SHA of the running build, or null when unknown. */
export const APP_GIT_SHA: string | null = shortSha;

/**
 * Display label for the sidebar version chip: "1.1.0" for a release, or
 * "1.1.0+abc1234" (semver build metadata) for a build past the last tag.
 */
export const APP_VERSION_LABEL: string = IS_RELEASE_BUILD
  ? pkg.version
  : `${pkg.version}+${shortSha}`;

/**
 * Where the version chip links: the GitHub release page for a release, or the
 * exact commit for a non-release build.
 */
export const APP_SOURCE_URL: string = IS_RELEASE_BUILD
  ? `${pkg.homepage}/releases/tag/v${pkg.version}`
  : `${pkg.homepage}/commit/${shortSha}`;

/**
 * Documentation for THIS build — the matching git tag's docs for a release, or
 * the running commit's docs tree otherwise, so the link always resolves to the
 * docs that ship with the running code. (For a release the tag must exist on
 * the remote; it's created as part of cutting the release.)
 */
export const APP_DOCS_URL: string = IS_RELEASE_BUILD
  ? `${pkg.homepage}/tree/v${pkg.version}/docs`
  : `${pkg.homepage}/tree/${shortSha}/docs`;
