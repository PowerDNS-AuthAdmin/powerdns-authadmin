## components/domain

Feature-specific UI components for DNS, audit, backend status, and admin
workflows.

Use shared primitives from `components/ui` for tables, dialogs, switches, and
other common controls. Components here should not reach into `lib/db`,
`lib/pdns`, or `lib/auth`; server components or route handlers pass data in.
