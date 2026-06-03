## lib/net

Network safety helpers for server-side outbound requests: host classification,
URL guardrails, and pinned fetch behavior that mitigates DNS rebinding.

Protocol-specific clients should call these helpers rather than duplicating
SSRF checks. This directory should not contain PowerDNS, OIDC, LDAP, or SAML
business logic.
