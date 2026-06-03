## lib/audit

Append-only audit-log support: the typed action vocabulary, audit writer,
secret redaction, CSV export, and display helpers.

This directory records what already happened. It does not decide whether a
caller is allowed to perform an operation, and resource mutations should still
live in route handlers or domain modules that call `appendAudit`.
