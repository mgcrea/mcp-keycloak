import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { redactSecrets, summarizeClient, summarizeEach } from "#/client/shape";
import {
  compact,
  confirmArg,
  firstArg,
  maxArg,
  realmArg,
  representationArg,
  wrap,
} from "#/tools/util";

const clientUuidArg = z
  .string()
  .min(1)
  .describe(
    "Client UUID — the `id` field, NOT the human-facing clientId string. Every /clients/{id} " +
      "path takes the UUID. Get it from keycloak_list_clients.",
  );

export const registerClientTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_clients",
    {
      description:
        "List the realm's clients (applications). Returns both `id` (the UUID every other client " +
        "tool needs) and `clientId` (the name shown in the console).",
      inputSchema: {
        realm: realmArg,
        clientId: z
          .string()
          .optional()
          .describe("Filter by the exact clientId string, e.g. `admin-cli`."),
        search: z
          .boolean()
          .optional()
          .describe("Treat `clientId` as an infix search instead of exact."),
        viewableOnly: z
          .boolean()
          .optional()
          .describe("Only clients this token is allowed to view."),
        first: firstArg,
        max: maxArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientId, search, viewableOnly, first, max }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(client.realmPath(realm, "/clients"), {
            ...compact({ clientId, search, viewableOnly }),
            first,
            max,
          }),
          summarizeClient,
        ),
      ),
  );

  server.registerTool(
    "keycloak_get_client",
    {
      description:
        "Get a client's full configuration: flows, redirect URIs, web origins, and its attributes " +
        "(including token lifespans). Its secret, if any, is redacted — use " +
        "keycloak_get_client_secret to read it.",
      inputSchema: { realm: realmArg, clientUuid: clientUuidArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(async () =>
        redactSecrets(await client.get(client.realmPath(realm, `/clients/${clientUuid}`))),
      ),
  );

  server.registerTool(
    "keycloak_get_client_secret",
    {
      description:
        "Get a confidential client's CURRENT SECRET IN PLAIN TEXT. This is a live credential — " +
        "it will appear in the conversation. Requires manage-clients. " +
        "(To keep it out of reach entirely, move this tool's registration behind KEYCLOAK_ALLOW_WRITES.)",
      inputSchema: { realm: realmArg, clientUuid: clientUuidArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(() => client.get(client.realmPath(realm, `/clients/${clientUuid}/client-secret`))),
  );

  server.registerTool(
    "keycloak_get_client_service_account_user",
    {
      description:
        "Get the service-account user backing a client. That user is where the client's admin " +
        "roles are assigned, so this is the way to check what a client can actually do.",
      inputSchema: { realm: realmArg, clientUuid: clientUuidArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(() =>
        client.get(client.realmPath(realm, `/clients/${clientUuid}/service-account-user`)),
      ),
  );

  server.registerTool(
    "keycloak_get_client_installation_config",
    {
      description:
        "Get the ready-to-use adapter config (keycloak.json) for a client — issuer URL, realm, " +
        "credentials. Handy for wiring an app up to this client.",
      inputSchema: { realm: realmArg, clientUuid: clientUuidArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(() =>
        client.get(
          client.realmPath(
            realm,
            `/clients/${clientUuid}/installation/providers/keycloak-oidc-keycloak-json`,
          ),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_client",
    {
      description:
        "Create a client (application). For a machine-to-machine client that can call this admin " +
        "API, set publicClient=false and serviceAccountsEnabled=true, then grant it " +
        "realm-management roles via keycloak_set_user_client_roles on its service-account user. " +
        "Returns the new client's UUID.",
      inputSchema: {
        realm: realmArg,
        clientId: z.string().min(1).describe("The client's public identifier, e.g. `my-app`."),
        name: z.string().optional().describe("Human-readable display name."),
        description: z.string().optional(),
        publicClient: z
          .boolean()
          .default(false)
          .describe("Public clients have no secret (browser/mobile apps). Default false."),
        serviceAccountsEnabled: z
          .boolean()
          .default(false)
          .describe("Enable the client_credentials grant and give the client a service account."),
        standardFlowEnabled: z
          .boolean()
          .default(true)
          .describe("Enable the authorization code flow."),
        directAccessGrantsEnabled: z
          .boolean()
          .default(false)
          .describe("Enable the password grant (resource owner credentials)."),
        redirectUris: z.array(z.string()).optional(),
        webOrigins: z.array(z.string()).optional(),
        rootUrl: z.string().optional(),
        representation: representationArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, representation, ...fields }) =>
      wrap(() =>
        client.post(client.realmPath(realm, "/clients"), {
          ...compact(fields),
          ...representation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_update_client",
    {
      description: "Update a client's configuration. Only the fields you pass are changed.",
      inputSchema: {
        realm: realmArg,
        clientUuid: clientUuidArg,
        representation: z
          .record(z.string(), z.unknown())
          .describe('Partial ClientRepresentation, e.g. {"redirectUris": ["https://app/*"]}.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, clientUuid, representation }) =>
      wrap(() => client.put(client.realmPath(realm, `/clients/${clientUuid}`), representation)),
  );

  server.registerTool(
    "keycloak_delete_client",
    {
      description:
        "Delete a client. Every application authenticating through it immediately stops working.",
      inputSchema: { realm: realmArg, clientUuid: clientUuidArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(() => client.del(client.realmPath(realm, `/clients/${clientUuid}`))),
  );

  server.registerTool(
    "keycloak_regenerate_client_secret",
    {
      description:
        "Generate a NEW secret for a client, invalidating the old one. Anything still using the " +
        "old secret — including possibly this MCP server itself — breaks immediately.",
      inputSchema: { realm: realmArg, clientUuid: clientUuidArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ realm, clientUuid }) =>
      wrap(() => client.post(client.realmPath(realm, `/clients/${clientUuid}/client-secret`))),
  );
};
