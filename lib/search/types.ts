/**
 * lib/search/types.ts
 *
 * The wire shape of `GET /api/search`, shared by the server (`lib/search`),
 * the MCP `search` tool and the client palette. No runtime code and no
 * server-only import, so the client component can type its fetch with it.
 */

/** The palette tabs, in display order. `all` groups every other scope. */
export const SEARCH_SCOPES = ["all", "zones", "records", "config", "requests", "audit"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export type SearchGroupKey = Exclude<SearchScope, "all">;

export type SearchItemKind =
  | "zone"
  | "record"
  | "setting"
  | "page"
  | "backend"
  | "cluster"
  | "user"
  | "team"
  | "role"
  | "template"
  | "auth-provider"
  | "request"
  | "audit";

/** Half-open `[start, end)` character spans to highlight. */
export type SearchRange = readonly [number, number];

export interface SearchItem {
  kind: SearchItemKind;
  group: SearchGroupKey;
  title: string;
  subtitle?: string;
  /**
   * Inline columns for the single-tab view. Keys per group:
   * zones `backend, horizon, kind`; records `type, content, zone`;
   * config `section, value`; requests `method, status, backend, time`;
   * audit `actor, resource, time`. `time` is an ISO-8601 instant.
   */
  meta?: Record<string, string>;
  href: string;
  score: number;
  /** Matched spans of `title`. */
  ranges: SearchRange[];
  /** Matched spans of `subtitle`, when the hit was there instead. */
  subtitleRanges?: SearchRange[];
}

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  /** Every match in this group, not just the items returned. */
  total: number;
  items: SearchItem[];
}

export interface SearchResponse {
  q: string;
  scope: SearchScope;
  groups: SearchGroup[];
  counts: Record<SearchGroupKey, number>;
}

/** Which palette tabs a user may see; the layout computes it from their grants. */
export type SearchTabVisibility = Record<SearchGroupKey, boolean>;

/** A shortcut shown while the query is empty. */
export interface SearchQuickLink {
  label: string;
  href: string;
  hint?: string;
}
