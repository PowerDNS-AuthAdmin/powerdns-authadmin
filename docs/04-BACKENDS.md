# Connecting PowerDNS backends

PowerDNS-AuthAdmin talks to one or many PowerDNS Authoritative servers over their
HTTP API. This guide covers enabling that API on PowerDNS, adding a backend, and
the three supported topologies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/powerdns-servers.png" />
  <img src="../screenshots/light/powerdns-servers.png" alt="PowerDNS servers — standalone, primary+secondaries, and cluster side by side" width="720" />
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
the webserver on a private network or behind your own TLS — the API key is a
full-control credential.

## 2. Add the backend

Two ways, both equivalent — they write the same `pdns_servers` row:

- **Admin UI** → **Admin → PowerDNS servers → Add server**.
- **Provisioning** → the `pdns_servers:` block (see [Provisioning](./06-PROVISIONING.md)).

| Field               | Notes                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Name** / **slug** | Display name and URL-safe identifier.                                                                            |
| **Base URL**        | The API root, ending in `/api/v1`. `https://` required in production unless `APP_PDNS_ALLOW_INSECURE_HTTP=true`. |
| **Server ID**       | The PDNS server-id path segment — almost always `localhost`.                                                     |
| **API key**         | The `X-API-Key`. Encrypted at rest with `APP_ENCRYPTION_KEY`; never sent back to the browser.                    |
| **Role**            | `primary` (read/write) or `secondary` (read-only mirror).                                                        |
| **Primary**         | For secondaries: which primary this mirrors.                                                                     |
| **Cluster**         | For multi-primary peers: the cluster this peer belongs to.                                                       |

The API key is stored encrypted, redacted in logs, and never round-tripped to the
client.

## The SSRF guard

The app refuses backend URLs that could be used to reach internal services, and
**re-resolves the hostname before every request** as a DNS-rebinding defense. The
validated address is then **pinned into the connection** — the request reaches the
exact IP the guard checked, so a hostile resolver can't hand a safe IP to the guard
and a private one to the HTTP client between the two lookups.

- **Link-local addresses are always blocked**, including the
  `169.254.169.254` cloud-metadata endpoint — no flag overrides this.
- `APP_PDNS_ALLOW_PRIVATE_NETWORKS=true` permits loopback / RFC1918 / CGNAT / IPv6
  ULA destinations — needed for in-cluster or docker-compose PowerDNS.
- `APP_PDNS_ALLOW_INSECURE_HTTP=true` permits `http://` base URLs.

For an internal `http://pdns:8081/api/v1` backend you need **both** flags. Defaults
are permissive in dev and strict in production — see [Configuration](./03-CONFIGURATION.md).

## Reachability and status

A background poller contacts every active backend every ~30 s (zone list) and
~60 s (statistics). The **Status** column on the servers page shows **Reachable ·
\<when\>** based on the last _successful_ contact (`last_seen_at`), so a healthy,
actively-polled backend reads "Reachable · just now". A backend with no successful
contact ever shows "Not yet reached"; one not reached in over 24 h is flagged on
the dashboard's "PDNS backends needing attention" widget.

- **Test** (per row) does an immediate version probe and updates the status.
- **Refresh all** re-probes every active backend's version at once.

## Background polling — opt-in for multi-peer topologies

AuthAdmin's replication-awareness layer (SYNCED/DESYNCED chip, per-zone
Sync and Statistics tabs, servers-list Sync column, dashboard PDNS
metrics, drift advisories) is powered by a background poller that ticks
against every configured backend. Whether it runs at all is controlled by
the `PDNS_BACKGROUND_POLLING` env var, **which defaults to `false`** (see
[Configuration → `PDNS_BACKGROUND_POLLING`](./03-CONFIGURATION.md#pdns_background_polling)).

The right value depends on the topology you're about to build:

| You're configuring …                                                     | Set `PDNS_BACKGROUND_POLLING` to |
| ------------------------------------------------------------------------ | -------------------------------- |
| **Standalone primary** (one PDNS, single instance, no AXFR replication). | `false` (default — leave it)     |
| Multiple **independent standalones** (no cross-server replication).      | `false`                          |
| **Primary + secondaries** (one writable backend mirrored over AXFR).     | `true` _(strongly recommended)_  |
| **Multi-primary cluster** (≥2 writable peers sharing storage).           | `true` _(strongly recommended)_  |

A polling-off install still works for every topology — the standalone /
single-primary path is its sweet spot, but you can run a primary +
secondaries on `false` if you prefer to keep AuthAdmin completely
operator-driven. The trade-off is that AuthAdmin won't show you when a
secondary has fallen behind on AXFR; you'd notice that through your own
PowerDNS monitoring (e.g. `pdns_control list-zones` cross-checks) or via
the **Test** button on `/admin/servers`.

## Topologies

### Standalone primary

A single read/write backend. Add it with `role: primary`, mark one backend
`is_default` so requests without an explicit server target resolve to it.

### Primary + secondaries

A writable primary plus one or more read-only mirrors that receive zones via
AXFR/IXFR after a NOTIFY. Add the primary as `role: primary` and each mirror as
`role: secondary` pointing at it. AuthAdmin routes **all writes to the primary**;
secondary sync state + stats are surfaced when
`PDNS_BACKGROUND_POLLING=true` (see [above](#background-polling--opt-in-for-multi-peer-topologies)).

For secondaries to auto-bootstrap a zone via PowerDNS supermaster, each zone's NS
set must include the receiving secondary's registered nameserver — see the
`zone_templates` notes in [`provisioning.example.yaml`](../provisioning.example.yaml).
The **Sync** column (visible when `PDNS_BACKGROUND_POLLING=true`) compares
each secondary's serial against the primary's.

### Multi-primary cluster

`N` writable peers sharing a replicated store (Galera, Postgres logical
replication, …). Define a `cluster`, then add each peer as `role: primary` bound to
that cluster. The cluster appears as **one logical backend** in every picker; a
**peer-selection strategy** routes each request to a peer:

| Strategy         | Behaviour                                                                   |
| ---------------- | --------------------------------------------------------------------------- |
| `round_robin`    | Spread requests across peers in order (default).                            |
| `random`         | Uniform random peer per request.                                            |
| `lowest_latency` | Peer with the lowest sampled p50 (falls back to round-robin until sampled). |
| `least_load`     | Peer with the fewest zones.                                                 |

Secondaries can't belong to a cluster — clusters are peer-groups of primaries.

## DNSSEC, TSIG, autoprimaries

Once a backend is connected, manage these from the zone and admin UIs (gated by
the matching permissions in [RBAC](./07-RBAC.md)):

- **DNSSEC** — create/activate/remove cryptokeys per zone.
- **TSIG keys** — `tsig.read` lists; `tsig.manage` creates/regenerates/reveals.
- **Autoprimaries** — register autoprimary entries for supermaster bootstrap.

---

[← Docs index](./README.md)
