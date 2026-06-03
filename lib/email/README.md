## lib/email

SMTP transport creation, message templates, and the send API used by password
reset, email verification, and account-change flows.

Configuration comes from `lib/env`. This directory should not make account or
authorization decisions; callers decide whether an email should be sent.
