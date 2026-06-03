## lib/rbac

Authorization policy: permission vocabulary, CASL ability building, target
ceilings, default roles, and zone-grant permission helpers.

RBAC decides what an already-authenticated actor can do. It should not query the
database directly from repositories, render UI, or talk to PowerDNS.
