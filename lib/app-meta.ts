/**
 * lib/app-meta.ts
 *
 * App identity surfaced in the UI — running version + canonical links.
 * package.json is the single source of truth, so cutting a release only
 * has to bump one file. Server-only: keeps package.json (scripts, the
 * full dependency tree) out of any client bundle.
 */

import "server-only";
import pkg from "@/package.json";

/** Semver of the running build, e.g. "1.0.1". */
export const APP_VERSION: string = pkg.version;

/** This version's GitHub release page (the `vX.Y.Z` tag). */
export const APP_RELEASE_URL = `${pkg.homepage}/releases/tag/v${pkg.version}`;

/**
 * Documentation for THIS version — pinned to the matching git tag so the app
 * always links to the docs that ship with the running build, not whatever
 * `main` happens to be. (The tag must exist on the remote for the link to
 * resolve; it's created as part of cutting the release.)
 */
export const APP_DOCS_URL = `${pkg.homepage}/tree/v${pkg.version}/docs`;
