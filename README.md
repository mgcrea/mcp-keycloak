# @mgcrea/mcp-keycloak

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Keycloak Admin
REST API**. It lets an agent explore and administer a Keycloak instance — realms, users,
groups, roles, clients, sessions, events, client scopes, protocol mappers, identity
providers and authentication flows.

The server is **read-only by default**. Mutating tools are not merely refused when writes
are off — they are never registered, so an agent cannot call them at all.

## Features

- Curated tools across the whole admin surface, with descriptions that spell out Keycloak's
  traps (`clientId` vs `id`, `search` vs `exact` vs `q`, roles-by-name vs roles-by-id).
- **Read-only by default.** `KEYCLOAK_ALLOW_WRITES=1` adds the write tools; the destructive
  ones then additionally require an explicit `confirm: true` on every call.
- Two auth grants: an **OAuth client-credentials service account** (recommended) or the
  **password grant** via `admin-cli` (handy for local testing). Tokens are cached, refreshed
  ahead of expiry, reused via the refresh token when Keycloak issues one, and re-fetched on a
  mid-session 401.
- List results are **summarized**, so listing a few hundred users doesn't flood the context;
  `get_*` tools still return the full representation.
- A `keycloak_request` escape hatch for any endpoint without a curated tool (GET-only unless
  writes are enabled).
- Native `fetch`, no runtime dependencies beyond the MCP SDK and Zod.

## Install

```bash
pnpm install
pnpm build
```

## Configure

The server needs admin credentials for your Keycloak. Pick one of the two grants.

### (A) Service account — recommended

1. In the realm you want to authenticate against, create a client (e.g. `mcp-keycloak`) with
   **Client authentication: ON** and **Service accounts roles: ON**.
2. Grant it admin rights: **Clients → your client → Service account roles → Assign role →
   filter by clients → `realm-management`**, then pick the roles you want. `realm-admin` is
   the composite that grants everything; for a read-only server, `view-realm`, `view-users`,
   `view-clients`, `view-events`, `view-identity-providers` are enough.
3. Copy the **Client ID** and **Client secret** into `.env`.

To administer _other_ realms from one client, create it in `master` and give it the `admin`
realm role instead.

### (B) Password grant — for quick local testing

Set `KEYCLOAK_CLIENT_ID=admin-cli` (a public client — leave the secret empty) plus
`KEYCLOAK_USERNAME` / `KEYCLOAK_PASSWORD`. This runs as that human admin, with everything
their account can do.

```bash
cp .env.example .env
```

| Variable                          | Required | Description                                                                                   |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `KEYCLOAK_URL`                    | yes      | Base URL, e.g. `https://keycloak.example.com`. No `/auth` prefix on Keycloak ≥ 17.            |
| `KEYCLOAK_REALM`                  | no       | Realm the tools operate on. Defaults to `master`. Every tool can override it per call.        |
| `KEYCLOAK_AUTH_REALM`             | no       | Realm to authenticate against. Defaults to `KEYCLOAK_REALM`; set to `master` for cross-realm. |
| `KEYCLOAK_CLIENT_ID`              | no       | Defaults to `admin-cli`.                                                                      |
| `KEYCLOAK_CLIENT_SECRET`          | (A)      | Service-account secret. Its presence selects the `client_credentials` grant.                  |
| `KEYCLOAK_USERNAME` / `_PASSWORD` | (B)      | Admin credentials for the password grant.                                                     |
| `KEYCLOAK_GRANT_TYPE`             | no       | Force `client_credentials` or `password`. Otherwise inferred from the above.                  |
| `KEYCLOAK_ALLOW_WRITES`           | no       | Set to `1` to register the write tools. Off by default.                                       |
| `KEYCLOAK_MAX_RETRIES`            | no       | Retry budget for 401 / 429 / 5xx. Defaults to `3`.                                            |
| `KEYCLOAK_REFRESH_SKEW_SECONDS`   | no       | Refresh this long before expiry. Defaults to `30`, clamped to half the token's lifetime.      |
| `KEYCLOAK_DEBUG`                  | no       | Set to `1` to log debug output to stderr.                                                     |

## Run

```bash
pnpm start   # speaks JSON-RPC over stdio
```

### Wire into Claude Code

Add to `.mcp.json` (project) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "keycloak": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-keycloak/dist/cli.js"],
      "env": {
        "KEYCLOAK_URL": "https://keycloak.example.com",
        "KEYCLOAK_CLIENT_ID": "mcp-keycloak",
        "KEYCLOAK_CLIENT_SECRET": "..."
      }
    }
  }
}
```

### Inspect the tools

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

Every tool takes an optional `realm` to override the configured default. Tools marked **W**
exist only when `KEYCLOAK_ALLOW_WRITES=1`; those marked ⚠️ are destructive and additionally
require `confirm: true`.

**Start with `keycloak_whoami`.** It reports which realm you authenticated against, as whom,
and which `realm-management` roles the token actually carries — which is what a 403 from any
other tool is nearly always about.

| Area               | Tools                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realms             | `whoami`, `get_server_info`, `list_realms`, `get_realm` · **W** `create_realm`, `update_realm`, ⚠️ `delete_realm`                                                                                                                                                                                               |
| Users              | `list_users`, `count_users`, `get_user`, `get_user_groups`, `get_user_role_mappings`, `get_user_sessions` · **W** `create_user`, `update_user`, `send_user_action_email`, `set_user_groups`, `set_user_realm_roles`, `set_user_client_roles`, ⚠️ `delete_user`, ⚠️ `reset_user_password`, ⚠️ `logout_user`      |
| Groups             | `list_groups`, `get_group`, `get_group_members`, `get_group_role_mappings` · **W** `create_group`, `update_group`, `set_group_realm_roles`, ⚠️ `delete_group`                                                                                                                                                   |
| Roles              | `list_realm_roles`, `get_realm_role`, `get_realm_role_members`, `get_role_composites`, `list_client_roles` · **W** `create_realm_role`, `update_realm_role`, `create_client_role`, ⚠️ `delete_realm_role`                                                                                                       |
| Clients            | `list_clients`, `get_client`, `get_client_secret`, `get_client_service_account_user`, `get_client_installation_config` · **W** `create_client`, `update_client`, ⚠️ `delete_client`, ⚠️ `regenerate_client_secret`                                                                                              |
| Sessions & events  | `get_realm_session_stats`, `get_client_sessions`, `get_client_session_count`, `get_events_config`, `list_events`, `list_admin_events` · **W** ⚠️ `delete_session`, ⚠️ `logout_all_sessions`, ⚠️ `clear_events`                                                                                                  |
| Scopes & mappers   | `list_client_scopes`, `get_client_scope`, `get_client_assigned_scopes`, `list_protocol_mappers`, `evaluate_client_scopes` · **W** `create_client_scope`, `update_client_scope`, `assign_client_scope`, `unassign_client_scope`, `create_protocol_mapper`, ⚠️ `delete_client_scope`, ⚠️ `delete_protocol_mapper` |
| Identity providers | `list_identity_providers`, `get_identity_provider`, `list_identity_provider_mappers` · **W** `create_identity_provider`, `update_identity_provider`, `create_identity_provider_mapper`, ⚠️ `delete_identity_provider`                                                                                           |
| Auth flows         | `list_authentication_flows`, `get_authentication_flow_executions`, `list_required_actions`, `get_realm_flow_bindings` · **W** `create_authentication_flow`, `copy_authentication_flow`, `update_authentication_execution`, ⚠️ `delete_authentication_flow`                                                      |
| Escape hatch       | `keycloak_request` — any admin endpoint. GET-only unless writes are enabled.                                                                                                                                                                                                                                    |

All names are prefixed `keycloak_`.

> **Sensitive:** `keycloak_get_client_secret` returns a client's secret in plain text (it needs
> `manage-clients` to work at all). It's registered as a read tool because it is a GET; to put
> it out of reach entirely, move its registration inside the `allowWrites` block in
> [src/tools/clients.ts](src/tools/clients.ts).

## Notes on Keycloak

A few things the tool descriptions repeat, because they cause most of the confusion:

- **`clientId` is not `id`.** Every `/clients/{id}/…` endpoint wants the client's UUID, while
  the console only ever shows the `clientId` string. List tools return both.
- **Searching users**: `search` is a loose match over username/name/email; `username` + `exact`
  is a precise lookup; `q` (`"key:value"`) is the only way to match custom attributes.
- **Events are off by default.** A realm with logging disabled returns an empty list rather than
  an error, so `list_events` checks and tells you when that's what happened. There is no backfill.
- **Access tokens live ~60 seconds.** The token provider refreshes ahead of expiry and clamps its
  skew to half the token's lifetime, so a short lifespan doesn't mean re-authenticating on every call.

## Develop

```bash
pnpm dev           # rebuild on change
pnpm test          # vitest
pnpm lint          # oxlint
pnpm format        # oxfmt
pnpm typecheck     # tsc --noEmit
```

## License

MIT
