/**
 * lib/app-meta.ts
 *
 * App identity surfaced in the UI — running version + canonical links.
 * package.json is the single source of truth for the semver, so cutting a
 * release only has to bump one file.
 *
 * Three build kinds, distinguished by the build env the image carries:
 *
 *   • release — image built from a `vX.Y.Z` tag (CI sets APP_RELEASE=true).
 *     Chip shows "1.1.0"; links point at the GitHub release + the tag's docs.
 *   • commit  — non-release image past the last tag (every push to `main`).
 *     CI injects the commit SHA (Dockerfile `runner` stage + the docker job),
 *     so the chip shows "1.1.0+abc1234" and links resolve to that exact commit
 *     — never claiming to be a release it isn't.
 *   • dev     — no VCS info at all: `npm run dev`, `npm run build && start`, or
 *     a plain `docker build` with no build-args. The running code isn't on the
 *     remote at any known ref, so we mark the chip "1.1.0-dev" and link to
 *     `main` rather than masquerade as a release or invent a 404-ing commit URL.
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

type BuildKind = "release" | "commit" | "dev";
const buildKind: BuildKind =
  process.env["APP_RELEASE"] === "true" ? "release" : shortSha !== null ? "commit" : "dev";

/** True only for an image built from a `vX.Y.Z` release tag. */
export const IS_RELEASE_BUILD: boolean = buildKind === "release";

/** Semver of the running build, e.g. "1.1.0". */
export const APP_VERSION: string = pkg.version;

/** Short commit SHA of the running build, or null when unknown (dev builds). */
export const APP_GIT_SHA: string | null = shortSha;

/**
 * Display label for the sidebar version chip: "1.1.0" for a release,
 * "1.1.0+abc1234" (semver build metadata) for a commit build, or "1.1.0-dev"
 * (semver pre-release) for a local/dev build with no commit info.
 */
export const APP_VERSION_LABEL: string =
  buildKind === "release"
    ? pkg.version
    : buildKind === "commit"
      ? `${pkg.version}+${shortSha}`
      : `${pkg.version}-dev`;

/**
 * Where the version chip links: the GitHub release page for a release, the
 * exact commit for a commit build, or `main` for a dev build.
 */
export const APP_SOURCE_URL: string =
  buildKind === "release"
    ? `${pkg.homepage}/releases/tag/v${pkg.version}`
    : buildKind === "commit"
      ? `${pkg.homepage}/commit/${shortSha}`
      : `${pkg.homepage}/tree/main`;

/**
 * Documentation for THIS build — the matching tag's docs for a release, the
 * running commit's docs tree for a commit build, or `main`'s docs for a dev
 * build, so the link always resolves to docs that actually exist for the
 * running code. (For a release the tag must exist on the remote; it's created
 * as part of cutting the release.)
 */
export const APP_DOCS_URL: string =
  buildKind === "release"
    ? `${pkg.homepage}/tree/v${pkg.version}/docs`
    : buildKind === "commit"
      ? `${pkg.homepage}/tree/${shortSha}/docs`
      : `${pkg.homepage}/tree/main/docs`;

/** `title` attribute for the version chip — phrased to match the link target. */
export const APP_SOURCE_TITLE: string =
  buildKind === "release"
    ? `PowerDNS-AuthAdmin v${APP_VERSION_LABEL} — view this release on GitHub`
    : buildKind === "commit"
      ? `PowerDNS-AuthAdmin v${APP_VERSION_LABEL} — view this commit on GitHub`
      : `PowerDNS-AuthAdmin v${APP_VERSION_LABEL} — local build, view the main branch on GitHub`;
