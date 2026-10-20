## lib/search

The global search behind the header palette, `GET /api/search` and the MCP
`search` tool.

- `fuzzy.ts` - pure fuzzy matcher (`scoreMatch`, `rankCandidates`): subsequence
  matching with prefix, word-boundary and consecutive-run bonuses, returning
  highlight ranges. No dependencies.
- `index.ts` - `searchEverything({ q, scope, auth, limit, sources })`: matches
  every source and filters each one by the permission its page uses
  (`canActOnZone` for zones and records, global permissions for admin data).
  Sources are injectable for tests.
- `sources.ts` - the production sources: the fleet scan and its zone-detail
  cache, the app database (narrow projections, no secret columns) and the
  settings cache, each memoised for a few seconds. The request and audit logs
  are matched over their newest 500 rows.
- `quick-links.ts` - empty-state shortcuts and tab visibility for the layout.
- `types.ts` - the response shape, shared with the client palette.

Never add a field that carries a secret to a source row: what a source returns
can end up in a response.

- `search-index.ts` - the prebuilt index: reads every source in the background, hot-swaps a
  complete snapshot after each change (debounced zone / audit / request-log events plus a
  five-minute rebuild), and publishes `search.index.updated`. Queries never do I/O.
