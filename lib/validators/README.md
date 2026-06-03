## lib/validators

Zod schemas for request bodies, query strings, configuration payloads, and DNS
record-type data at application boundaries.

Past this directory, code should work with narrowed typed values. Do not put
database writes, PowerDNS calls, or UI rendering in validators.
