## lib/dyndns

Dynamic DNS request parsing and normalization for the `/nic/update` surface.

This directory should stay focused on the DynDNS protocol contract. Auth,
authorization, audit logging, and PowerDNS writes are handled by the route and
the PDNS domain modules.
