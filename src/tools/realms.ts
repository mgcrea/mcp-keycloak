import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { describeIdentity } from "#/client/identity";
import { summarizeServerInfo } from "#/client/shape";
import type { ConfiguredToolContext } from "#/tools/index";
import { briefArg, compact, confirmArg, realmArg, representationArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

export const registerRealmTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  ctx: ConfiguredToolContext,
): void => {
  const { allowWrites } = ctx;

  server.registerTool(
    "keycloak_whoami",
    {
      title: "Keycloak: Whoami",
      description:
        "Show who the server is authenticated as and what it is actually allowed to do: the " +
        "issuing realm, the client, the acting user, token expiry, and the realm + " +
        "'realm-management' roles that govern admin access. The roles are read from the account's " +
        "role mappings on the server, not from the token — Keycloak issues tokens with no role " +
        "claims to some clients, so the token alone proves nothing. " +
        "Call this FIRST when another tool returns 403.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => describeIdentity({ client, ...ctx })),
  );

  server.registerTool(
    "keycloak_get_server_info",
    {
      title: "Keycloak: Get Server Info",
      description:
        "Keycloak server version, uptime, JVM/memory info and enabled feature flags. " +
        "The raw endpoint also dumps every SPI provider and theme (~1MB); this returns only the " +
        "useful head of it.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeServerInfo(await client.get<Rec>("/admin/serverinfo"))),
  );

  server.registerTool(
    "keycloak_list_realms",
    {
      title: "Keycloak: List Realms",
      description: "List the realms this token can see.",
      inputSchema: { briefRepresentation: briefArg },
      annotations: { readOnlyHint: true },
    },
    async ({ briefRepresentation }) =>
      wrap(() => client.get("/admin/realms", { briefRepresentation })),
  );

  server.registerTool(
    "keycloak_get_realm",
    {
      title: "Keycloak: Get Realm",
      description:
        "Get a realm's full configuration: token lifespans, login/registration settings, " +
        "password policy, SSO session timeouts, and the flow bindings.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) => wrap(() => client.get(client.realmPath(realm))),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_realm",
    {
      title: "Keycloak: Create Realm",
      description: "Create a new realm.",
      inputSchema: {
        realmName: z.string().min(1).describe("Name of the realm to create, e.g. `staging`."),
        enabled: z.boolean().default(true),
        displayName: z.string().optional(),
        representation: representationArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ realmName, enabled, displayName, representation }) =>
      wrap(() =>
        client.post("/admin/realms", {
          ...compact({ realm: realmName, enabled, displayName }),
          ...representation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_update_realm",
    {
      title: "Keycloak: Update Realm",
      description:
        "Update a realm's configuration. Only the fields you pass are changed. " +
        "Useful for turning on event logging (`eventsEnabled`, `adminEventsEnabled`).",
      inputSchema: {
        realm: realmArg,
        representation: z
          .record(z.string(), z.unknown())
          .describe(
            'Partial RealmRepresentation, e.g. {"eventsEnabled": true, "adminEventsEnabled": true} ' +
              'or {"loginWithEmailAllowed": false}.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, representation }) =>
      wrap(() => client.put(client.realmPath(realm), representation)),
  );

  server.registerTool(
    "keycloak_delete_realm",
    {
      title: "Keycloak: Delete Realm",
      description:
        "DELETE AN ENTIRE REALM, including every user, client, group and role in it. " +
        "Instant and irreversible — there is no undo and no trash.",
      inputSchema: {
        realm: z.string().min(1).describe("Realm to delete. Required — no default, on purpose."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm }) => wrap(() => client.del(client.realmPath(realm))),
  );
};
