## components/domain

Feature-specific UI components for DNS, audit, backend status, and admin
workflows.

Use shared primitives from `components/ui` for tables, dialogs, switches, and
other common controls. Components here should not reach into `lib/db`,
`lib/pdns`, or `lib/auth`; server components or route handlers pass data in.

Reverse DNS and zone monitoring pieces: `ptr-links.tsx` / `ptr-links-format.ts`
(the A/AAAA ↔ PTR chips in record tables, fed by the links API),
`zone-monitor-findings.tsx` / `zone-monitor-format.ts` (verdict chips, finding
lists and the result summary used by the Zone Monitoring page).

Global search: `global-search.tsx` is the header palette (trigger from
`components/ui/search-trigger.tsx`, results from `GET /api/search`, wire types
from `lib/search/types.ts`). Tab visibility and quick links arrive as props
from the `(app)` layout.

- `ptr-row-groups.ts` - folds Reverse DNS rows that report the same finding (orphan, mismatch, unhosted with identical targets, forward names and scope) into one row, sorts addresses numerically, and caps long cell lists at three entries. Pure, unit-tested.
