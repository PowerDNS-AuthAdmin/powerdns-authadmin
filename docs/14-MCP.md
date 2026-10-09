# Natural-language DNS with MCP

PowerDNS-AuthAdmin exposes a [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server at `/api/mcp`. Point an MCP-capable assistant at it - Claude Code, Codex, Cursor, or
anything that speaks MCP over HTTP - and manage zones and records by describing what you want:

> "Add a TXT record `_acme-challenge.shop` on example.com with the value `abc123`, TTL 60."
> "What MX records does example.com have? Replace them with mail1 and mail2 at mail.example.net, preference 10 and 20."
> "Create the zone staging.example.com with the usual nameservers and point `www` at 192.0.2.10."

Every tool call runs **as the token's owner**: the same RBAC ceilings, zone grants, per-RR-type
validation, optimistic concurrency, NOTIFY and audit log as the web UI and the REST API. The
assistant gets no power the token owner doesn't have, and every change it makes shows up in
the audit log under that owner's name with the MCP client's user agent.

## 1. Create a token

MCP clients authenticate with a **personal access token**. In the app go to
**Profile → API tokens → Create**, give it a name, and pick scopes. Scopes are intersected with
your own permissions and are the ceiling for everything the assistant can do:

| Want the assistant to…     | Scopes                                                         |
| -------------------------- | -------------------------------------------------------------- |
| only look                  | `zone.read`                                                    |
| edit records               | `zone.read`, `record.create`, `record.update`, `record.delete` |
| also create / delete zones | add `zone.create`, `zone.delete`                               |

Leave scopes empty to inherit everything you hold (re-evaluated on every call). The token is
shown once; copy it. Revoke it from the same page at any time - revocation is immediate.

> A token with a per-zone grant instead of a global role is the right shape for a bot that
> should only ever touch one zone. See [RBAC → per-zone grants](./07-RBAC.md).

## 2. Connect a client

The endpoint is `https://<your-app>/api/mcp`, transport **Streamable HTTP**, auth header
`Authorization: Bearer pda_pat_…`. The server is stateless: no session ids, plain JSON
responses, safe behind any reverse proxy and across replicas.

### Claude Code

```sh
claude mcp add --transport http powerdns https://dns.example.com/api/mcp \
  --header "Authorization: Bearer pda_pat_xxxxxxxx"
```

Or commit a project-level `.mcp.json` (the token stays in the environment):

```json
{
  "mcpServers": {
    "powerdns": {
      "type": "http",
      "url": "https://dns.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${PDNS_AUTHADMIN_TOKEN}" }
    }
  }
}
```

Then, inside Claude Code: `/mcp` shows the connection, and you simply ask.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.powerdns]
url = "https://dns.example.com/api/mcp"
bearer_token_env_var = "PDNS_AUTHADMIN_TOKEN"
```

Export `PDNS_AUTHADMIN_TOKEN=pda_pat_…` in the shell that launches Codex.

### Cursor, Windsurf and other HTTP-capable clients

Any client that takes a `url` plus `headers` works the same way:

```json
{
  "mcpServers": {
    "powerdns": {
      "url": "https://dns.example.com/api/mcp",
      "headers": { "Authorization": "Bearer pda_pat_xxxxxxxx" }
    }
  }
}
```

### Clients that only speak stdio

Bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "powerdns": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://dns.example.com/api/mcp",
        "--header",
        "Authorization: Bearer pda_pat_xxxxxxxx"
      ]
    }
  }
}
```

The endpoint does not implement OAuth; a client that insists on an OAuth flow for remote
servers (Claude Desktop's hosted connectors, for example) needs the stdio bridge above.

## 3. What the assistant can do

| Tool             | Needs                                  | Does                                                                                              |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `list_backends`  | a valid token                          | The PowerDNS backends and their slugs (pass `server_slug` elsewhere when there is more than one). |
| `list_zones`     | `zone.read` (global or per-zone grant) | Zones the caller may read, across backends, optional substring filter.                            |
| `get_zone`       | `zone.read`                            | Kind, serial, DNSSEC state, nameservers, record counts by type.                                   |
| `list_records`   | `zone.read`                            | One row per value, filter by name and/or type, paginated.                                         |
| `set_records`    | `record.create` / `record.update`      | **Replace** every value of one name + type.                                                       |
| `add_record`     | `record.create` / `record.update`      | Append one value, keeping the others.                                                             |
| `delete_records` | `record.delete`                        | Remove one value, or the whole name + type.                                                       |
| `create_zone`    | `zone.create`                          | New zone (Native / Primary / Secondary) with optional nameservers.                                |
| `delete_zone`    | `zone.delete`                          | Delete a zone; the assistant must repeat the name as `confirm`.                                   |

Write tools are only advertised to tokens that can write somewhere, so a read-only token
presents a read-only server and the assistant never tries. The SOA is edited through the UI
only; the apex NS set needs `record.update.apex-ns` exactly as in the UI.

Names follow the editor's conventions: `www` is relative to the zone, `www.example.com.` is
absolute, `@` is the apex. TXT values are quoted, MX values carry their preference, hostnames
end with a dot. The validators that run on every save in the UI run here too, so a malformed
value comes back as a readable error the assistant can correct.

## 4. Testing by hand

```sh
TOKEN=pda_pat_xxxxxxxx; URL=https://dns.example.com/api/mcp
curl -sS $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -sS $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -sS $URL -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_records","arguments":{"zone":"example.com","type":"MX"}}}'
```

A missing or invalid token answers `401` with a `WWW-Authenticate: Bearer` header; a browser
session cookie is never accepted on this endpoint.

## 5. Security notes

- **Scope the token.** Give a bot the minimum: a per-zone grant beats a global role, and
  `zone.read` alone is enough for "what does my DNS look like" questions.
- **Prompt injection.** The assistant reads record contents you ask about; a TXT record is
  untrusted text. The tools expose only what the token may already do, and destructive tools
  (`set_records`, `delete_records`, `delete_zone`) are annotated as such so clients that ask
  for confirmation on destructive calls will do so. Configure your client to require approval
  for them in production.
- **Audit.** Filter the audit log by the token owner to see everything an assistant did; the
  request user agent identifies the client.
- **Rate limits.** The endpoint shares the API token path's Argon2 verification per request; a
  busy agent loop costs the same as a busy script.

## Where

`app/api/mcp/route.ts` (transport + auth), `app/api/mcp/_server.ts` (tool definitions),
`app/api/mcp/_dispatch.ts` (writes delegated to the REST route handlers), `app/api/mcp/_records.ts`
(name canonicalisation + flattening, unit-tested).
