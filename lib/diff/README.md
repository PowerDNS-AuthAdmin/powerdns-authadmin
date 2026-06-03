## lib/diff

Pure diffing helpers used to present before/after state, especially JSON-line
changes in audit and zone-change surfaces.

Keep this directory side-effect free. It should not know about the database,
authorization, or network clients.
