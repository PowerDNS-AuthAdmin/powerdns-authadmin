## lib/pdns

Typed PowerDNS Authoritative API integration: HTTP client, topology handling,
zone and RRset operations, TSIG/DNSSEC support, capability detection, and
cluster helpers.

This is the protocol/domain adapter. RBAC and audit happen above it. The few
sanctioned database bridge modules are documented in ADR-0013 and carry explicit
lint exceptions.
