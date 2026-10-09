# Connecting PowerDNS backends

PowerDNS-AuthAdmin talks to one or many PowerDNS Authoritative servers over their
HTTP API. This guide covers enabling that API on PowerDNS, adding a backend, and
the three supported topologies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/powerdns-servers.png" />
  <img src="../screenshots/light/powerdns-servers.png" alt="PowerDNS servers - standalone, primary+secondaries, and cluster side by side" width="720" />
</picture>

## 1. Enable the PowerDNS HTTP API

On each PowerDNS Authoritative server, the API and webserver must be on. In
`pdns.conf`:

```ini
api=yes
api-key=CHANGE_ME_to_a_long_random_key
webserver=yes
webserver-address=0.0.0.0          # bind where AuthAdmin can reach it
webserver-port=8081
webserver-allow-from=10.0.0.0/8    # restrict to AuthAdmin's network/IP
```

The **API root URL** AuthAdmin needs is `http(s)://<host>:8081/api/v1`, and the
**API key** is the `api-key` value above (sent as the `X-API-Key` header). Keep
the webserver on a private network or behind your own TLS - the API key is a
full-control credential.

## 2. Add the backend

Two ways, both equivalent - they write the same `pdns_servers` row:

- **Admin UI** → **Admin → PowerDNS servers → Add server**.
- **Provisioning** → the `pdns_servers:` block (see [Provisioning](./06-PROVISIONING.md)).

| Field               | Notes                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name** / **slug** | Display name and URL-safe identifier.                                                                                                         |
| **Base URL**        | The API root, ending in `/api/v1`. `https://` required in production unless `APP_PDNS_ALLOW_INSECURE_HTTP=true`.                              |
| **Server ID**       | The PDNS server-id path segment - almost always `localhost`.                                                                                  |
| **API key**         | The `X-API-Key`. Encrypted at rest with `APP_ENCRYPTION_KEY`; never sent back to the browser.                                                 |
| **Cluster**         | The group this backend belongs to - a multi-primary cluster, or a primary with its secondaries (`cluster_slug`).                              |
| **Read-only**       | **Never write to this backend** (`write_mode: read_only`) - see [hidden primary](#hidden-primary--read-only-public-nameservers-native-zones). |

There is no role field. Whether a backend is a primary or a secondary is
**observed** from its `/config` (`primary`, `secondary`, `autosecondary` - see
[ADR-0014](./adr/0014-backend-capability-model.md)) and shown as capability
badges; you only say which backends belong together.

The API key is stored encrypted, redacted in logs, and never round-tripped to the
client.

## The SSRF guard

The app refuses backend URLs that could be used to reach internal services, and
**re-resolves the hostname before every request** as a DNS-rebinding defense. The
validated address is then **pinned into the connection** - the request reaches the
exact IP the guard checked, so a hostile resolver can't hand a safe IP to the guard
and a private one to the HTTP client between the two lookups.

- **Link-local addresses are always blocked**, including the
  `169.254.169.254` cloud-metadata endpoint - no flag overrides this.
- `APP_PDNS_ALLOW_PRIVATE_NETWORKS=true` permits loopback / RFC1918 / CGNAT / IPv6
  ULA destinations - needed for in-cluster or docker-compose PowerDNS.
- `APP_PDNS_ALLOW_INSECURE_HTTP=true` permits `http://` base URLs.

For an internal `http://pdns:8081/api/v1` backend you need **both** flags. Defaults
are permissive in dev and strict in production - see [Configuration](./03-CONFIGURATION.md).

## Reachability and status

With `PDNS_BACKGROUND_POLLING=true` (see below) a background poller refreshes
zone state every ~30 s and daemon capabilities + statistics every ~60 s (plus a
5-minute metric snapshot for the dashboard charts) against every active backend;
otherwise `last_seen_at` only moves on page loads, **Test** and **Refresh all**.
The **Status** column on the servers page
shows **Reachable · \<when\>** based on the last _successful_ contact
(`last_seen_at`), so a healthy, actively-polled backend reads "Reachable · just
now". A backend with no successful contact ever shows "Not yet reached"; one not
reached in over 24 h is flagged on the dashboard's "PDNS backends needing
attention" widget.

- **Test** (per row) does an immediate version probe and updates the status.
- **Refresh all** re-probes every active backend's version at once.

## Background polling - opt-in for multi-peer topologies

AuthAdmin's replication-awareness layer (SYNCED/DESYNCED chip, per-zone
Sync and Statistics tabs, servers-list Sync column, dashboard PDNS
metrics, drift advisories) is powered by a background poller that ticks
against every configured backend. Whether it runs at all is controlled by
the `PDNS_BACKGROUND_POLLING` env var, **which defaults to `false`** (see
[Configuration → `PDNS_BACKGROUND_POLLING`](./03-CONFIGURATION.md#pdns_background_polling)).

The right value depends on the topology you're about to build:

| You're configuring …                                                     | Set `PDNS_BACKGROUND_POLLING` to |
| ------------------------------------------------------------------------ | -------------------------------- |
| **Standalone primary** (one PDNS, single instance, no AXFR replication). | `false` (default - leave it)     |
| Multiple **independent standalones** (no cross-server replication).      | `false`                          |
| **Primary + secondaries** (one writable backend mirrored over AXFR).     | `true` _(strongly recommended)_  |
| **Multi-primary cluster** (≥2 writable peers sharing storage).           | `true` _(strongly recommended)_  |

A polling-off install still works for every topology - the standalone /
single-primary path is its sweet spot, but you can run a primary +
secondaries on `false` if you prefer to keep AuthAdmin completely
operator-driven. The trade-off is that AuthAdmin won't show you when a
secondary has fallen behind on AXFR; you'd notice that through your own
PowerDNS monitoring (e.g. `pdns_control list-zones` cross-checks) or via
the **Test** button on `/admin/servers`.

## Topologies

### Standalone primary

A single read/write backend. Add it with no cluster, and mark one backend
`is_default` so requests without an explicit server target resolve to it.

### Primary + secondaries

A writable primary plus one or more read-only mirrors that receive zones via
AXFR/IXFR after a NOTIFY. Add each backend, then put the primary and its
secondaries in **one group** (the same `cluster_slug`) - which member is the
primary is observed from the daemon (`primary=yes` vs `secondary=yes` in its
`/config`), and the group renders as **Primary + secondaries**. AuthAdmin routes
**all writes to the primary**; secondary sync state + stats are surfaced when
`PDNS_BACKGROUND_POLLING=true` (see [above](#background-polling---opt-in-for-multi-peer-topologies)).

For secondaries to auto-bootstrap a zone via PowerDNS supermaster, each zone's NS
set must include the receiving secondary's registered nameserver - see the
`zone_templates` notes in [`provisioning.example.yaml`](../provisioning.example.yaml).
The **Sync** column (visible when `PDNS_BACKGROUND_POLLING=true`) compares
each secondary's serial against the primary's.

### Multi-primary cluster

`N` writable peers sharing a replicated store (Galera, Postgres logical
replication, …). Define a `cluster`, then add each peer bound to that cluster
(`cluster_slug`). The cluster appears as **one logical backend** in every picker; a
**peer-selection strategy** routes each request to a peer:

| Strategy         | Behaviour                                                                   |
| ---------------- | --------------------------------------------------------------------------- |
| `round_robin`    | Spread requests across peers in order (default).                            |
| `random`         | Uniform random peer per request.                                            |
| `lowest_latency` | Peer with the lowest sampled p50 (falls back to round-robin until sampled). |
| `least_load`     | Peer with the fewest zones.                                                 |

Both writable peers and read-only mirrors can be group members; what makes a
group a **multi-primary cluster** is that every member reports itself writable.
One writable member plus mirrors renders as **Primary + secondaries** instead.

### Hidden primary + read-only public nameservers (native zones)

A common shape that needs one extra step: all zones are `Native`, edits happen on
a hidden primary, and the public nameservers receive them through **database
replication** rather than AXFR. Those public nodes typically run against a
read-only database user.

PowerDNS reports such a daemon as `primary=no, secondary=no` - identical to a
plain standalone primary - so AuthAdmin cannot tell it apart, and by default the
peer-selection strategy will happily route a write to it, which then fails.

Tick **Never write to this backend (read-only)** on each public node (or set
`write_mode: read_only` in provisioning YAML). That backend is then:

- excluded from peer selection, so every write lands on the hidden primary;
- excluded from the create-zone and zones-list backend pickers;
- ineligible to be the default backend;
- still fully browsable, and still polled for sync state and stats.

Group the hidden primary and its public nodes together so the group renders as
**Primary + secondaries** rather than a multi-primary cluster.

> The **default backend** setting is unrelated: it only chooses which backend
> serves a request that doesn't name one. It has never constrained peer
> selection inside a group.

## DNSSEC, TSIG, autoprimaries

Once a backend is connected, manage these from the zone and admin UIs (gated by
the matching permissions in [RBAC](./07-RBAC.md)):

- **DNSSEC** - sign/unsign a zone, rectify, and manage its cryptokeys
  (see [DNSSEC](#dnssec) below).
- **TSIG keys** - `tsig.read` lists; `tsig.manage` creates/regenerates/reveals.
- **Autoprimaries** - register autoprimary entries for supermaster bootstrap.

## DNSSEC

PowerDNS signs on the fly: the primary holds the keys and signs each answer as
it goes out. Secondaries that receive the zone over AXFR get the signatures
with it and store the zone as **presigned**. A PowerDNS secondary sets this
itself on the first signed transfer. They serve those stored RRSIGs and hold no
keys.

Requirements: a DNSSEC-capable backend on every server (`gsqlite3-dnssec=yes`,
`gmysql-dnssec=yes`, `gpgsql-dnssec=yes`, ...). The secondaries need it too,
or they can't store a presigned zone.

### Enabling

Zone → **DNSSEC** tab → **Enable DNSSEC** (`dnssec.configure`), or
`POST /api/admin/pdns/zones/{zone}/dnssec`. This sends one
`PUT /zones/{zone}` with `dnssec: true` to PowerDNS, which in a single
transaction:

1. adds PowerDNS' default keys (`default-ksk-algorithm` /
   `default-zsk-algorithm`; on 4.9 that's one ECDSA P-256 CSK),
2. **rectifies** the zone (API-RECTIFY is switched on in the same request),
3. switches to NSEC, or NSEC3 if you pass `nsec3param`,
4. bumps the serial per SOA-EDIT-API.

The same request also sets **SOA-EDIT to `INCREMENT-WEEKS`** if the zone is
transferred (Master/Primary kind, or mirrored by a managed backend) and has no
SOA-EDIT yet. AuthAdmin then makes sure the served serial actually moved,
bumping the SOA serial itself if PowerDNS didn't (no SOA-EDIT-API on the zone).
Finally it NOTIFYs the secondaries so they transfer the signed zone right away.

PowerDNS caches zone metadata, SOA-EDIT included, for
`zone-metadata-cache-ttl` (60 s by default). A zone PUT doesn't clear that
cache on 4.6-4.8, and AuthAdmin's cache flush only clears it on 4.9+. So right
after SOA-EDIT changes, the primary can briefly keep serving and reporting
the old serial, and the first NOTIFY carries that old serial. When SOA-EDIT
changed, AuthAdmin therefore sends a second NOTIFY once the cache TTL has
passed. The response reports this as `followUpNotifyInSeconds`. Until then,
`servedSerial` may still equal `serial`.
The call is idempotent. On an already-signed zone it applies the settings,
rectifies, bumps and notifies, which also repairs a zone that was signed by
adding keys one at a time.

**Why rectify matters.** Signed zones need each record's `ordername` and `auth`
flag computed. That's what NSEC/NSEC3 denial of existence (NXDOMAIN, NODATA) is
built from. PowerDNS fills them in on rectify. Rectify on an unsigned zone
leaves `ordername` empty, so a zone that gets keys without a rectify serves
broken denial proofs. `POST /zones/{zone}/cryptokeys` on PowerDNS does **not**
rectify. AuthAdmin's cryptokey route now rectifies after adding a key, and
**Rectify zone** / `PUT .../rectify` is there for zones edited outside the API.
Rectify doesn't change the serial, so on a transferred zone AuthAdmin bumps
the serial and NOTIFYs. Otherwise presigned secondaries would keep the old
NSEC chain.

### SOA-EDIT and presigned secondaries

PowerDNS signatures are valid for about three weeks and are re-signed weekly.
A presigned secondary only refreshes its copy when the served serial changes.
On a zone that isn't edited, its signatures eventually expire, and validating
resolvers then treat the zone as bogus on those secondaries. `SOA-EDIT` fixes
this: with `INCREMENT-WEEKS` (or `INCEPTION-INCREMENT`) the primary serves a
serial that changes every week, and the secondaries re-transfer fresh
signatures. The DNSSEC tab warns when a transferred, signed zone has no
SOA-EDIT.

What this means for the sync indicators:

- PowerDNS reports `serial` (stored) and `edited_serial` (after SOA-EDIT, the
  value it serves). A secondary stores the served value, so AuthAdmin compares
  the mirror against the primary's **`edited_serial`**. The zone page shows
  both.
- The weekly SOA-EDIT change happens at the epoch-week boundary (Thursday
  00:00 UTC) and PowerDNS sends **no NOTIFY** for it. Secondaries pick it up at
  their next SOA refresh. For one SOA refresh interval after the boundary
  (3 h when the refresh isn't known), a mirror that is exactly that far behind
  shows as **refresh due** instead of desynced. It doesn't trip the header chip
  or the replication-drift advisory. A content change that hasn't reached a
  secondary within that window is also reported as refresh due until the
  window closes.
- The record diff on the zone's **Sync** tab compares the SOA without its
  serial. For a signed zone it leaves out RRSIG, DNSKEY, CDS, CDNSKEY and
  NSEC/NSEC3/NSEC3PARAM, which the secondary stores and the primary only
  generates. It shows a count of those instead.
- Don't remove or downgrade SOA-EDIT on a zone the secondaries already hold.
  The served serial would drop below theirs, they never transfer a lower
  serial, and they'd keep serving the old (signed) copy. The mirror then shows
  as **ahead**. Disabling DNSSEC leaves SOA-EDIT in place for this reason.

### LUA and ALIAS records

PowerDNS transfers LUA records unexpanded. A presigned secondary can't sign the
answers it computes from them, so validating resolvers see those names as bogus
on the secondaries. Keep LUA records out of signed zones served by presigned
secondaries. ALIAS has the same problem. Set `outgoing-axfr-expand-alias=yes`
on the primary so ALIASes are transferred expanded (and signed). Their
addresses then only refresh on the next transfer. Enabling DNSSEC returns a
warning when the zone holds either type.

### Rolling out safely

1. **Sign.** Enable DNSSEC on the zone.
2. **Verify on every nameserver** before telling the parent anything. Check
   that `dig +dnssec SOA example.com @<each NS>` returns an RRSIG, that a
   nonexistent name returns NXDOMAIN with NSEC/NSEC3 records, and that the
   zone's Sync tab (or `GET .../dnssec` → `mirrors`) shows every secondary
   in sync. A validating check such as `delv @<ns> example.com SOA` with the
   DNSKEY as trust anchor, or an online DNSSEC analyzer against the unsigned
   delegation, catches anything left over.
3. **Publish the DS** at the registrar. Use the SHA-256 one (digest type 2)
   from the DNSSEC tab or `GET .../cryptokeys` → top-level `ds`, which leaves
   out SHA-1.

**Rollback** is the reverse: remove the DS at the registrar, wait at least the
DS TTL at the parent (often 1-2 days), and only then disable DNSSEC. Unsigning
while a DS is still published makes validating resolvers SERVFAIL the whole
zone. The disable route therefore requires `confirm=<zone>`.

### API

All four take `serverSlug`. Pass it whenever the install has no default
backend. Bearer (PAT) requests don't need the CSRF header. Examples use
`https://dns-admin.example.com`, a PAT in `$PAT`, and a backend with slug
`primary-1`.

```sh
# Status: dnssec flag, SOA-EDIT, keys, DS to publish, per-mirror sync state
curl -s -H "Authorization: Bearer $PAT" \
  "https://dns-admin.example.com/api/admin/pdns/zones/example.com./dnssec?serverSlug=primary-1"

# Enable (all body fields optional; defaults shown in the comments)
curl -s -X POST -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d '{"serverSlug":"primary-1"}' \
  "https://dns-admin.example.com/api/admin/pdns/zones/example.com./dnssec"
#   "soaEdit":     auto → "INCREMENT-WEEKS" for a transferred zone without one; "" leaves it unset
#   "apiRectify":  true
#   "nsec3param":  omitted → NSEC; e.g. "1 0 0 -" for NSEC3 (RFC 9276 parameters)
#   "nsec3narrow": false
#   "notify":      true
# → 201 (200 if it was already signed) with the status fields plus
#   alreadyEnabled, serialAdvance ("pdns" | "patched" | "unchanged"), notified, warnings[]

# Keys + DS (never returns private key material)
curl -s -H "Authorization: Bearer $PAT" \
  "https://dns-admin.example.com/api/admin/pdns/zones/example.com./cryptokeys?serverSlug=primary-1"
# → {"zone":"example.com.","dnssec":true,
#    "cryptokeys":[{"id":1,"keytype":"csk","active":true,"published":true,"flags":257,
#                   "algorithm":"ECDSAP256SHA256","bits":256,"dnskey":"257 3 13 ...",
#                   "ds":["<tag> 13 1 <sha1>", "<tag> 13 2 <sha256>", "<tag> 13 4 <sha384>"],
#                   "cds":[...]}],
#    "ds":["<tag> 13 2 <sha256>", "<tag> 13 4 <sha384>"]}
# Per-key ds[] is whatever PowerDNS returns, SHA-1 included. The top-level ds[]
# leaves out SHA-1 (type 1) and GOST (type 3): RFC 8624 rules SHA-1 out for DS,
# and registrars warn on it or refuse it. Pick digest type 2 explicitly.

# Rectify (bumpSerial defaults to true for a transferred zone)
curl -s -X PUT -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d '{"serverSlug":"primary-1"}' \
  "https://dns-admin.example.com/api/admin/pdns/zones/example.com./rectify"

# Disable - remove the DS at the registrar and wait out its TTL FIRST
curl -s -X DELETE -H "Authorization: Bearer $PAT" \
  "https://dns-admin.example.com/api/admin/pdns/zones/example.com./dnssec?serverSlug=primary-1&confirm=example.com"
```

`GET` needs `dnssec.read`. Enable, disable and rectify need `dnssec.configure`
(type-level, or a zone grant). Enable sets SOA-EDIT and API-RECTIFY as part of
signing, so it doesn't need `zone.update`. All three writes are audited
(`dnssec.enable`, `dnssec.disable`, `dnssec.rectify`), and mirror zones
(Slave/Secondary/Consumer) are refused.

---

[← Docs index](./README.md)
