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
