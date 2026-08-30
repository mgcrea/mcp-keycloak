import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { compact, confirmArg, realmArg, representationArg, wrap } from "#/tools/util";

// A protocol mapper hangs off EITHER a client or a client scope; the two paths
// are otherwise identical, so resolve the owner once.
const ownerPath = (
  client: KeycloakAdminClient,
  realm: string | undefined,
  clientUuid: string | undefined,
  scopeId: string | undefined,
): string => {
  if (clientUuid) return client.realmPath(realm, `/clients/${clientUuid}`);
  if (scopeId) return client.realmPath(realm, `/client-scopes/${scopeId}`);
  throw new Error("Pass exactly one of `clientUuid` or `scopeId`.");
};

const oneOwner = <T extends { clientUuid?: string | undefined; scopeId?: string | undefined }>(
  args: T,
): T => {
  if (Boolean(args.clientUuid) === Boolean(args.scopeId)) {
    throw new Error("Pass exactly one of `clientUuid` or `scopeId`, not both and not neither.");
  }
  return args;
};

export const registerScopeTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_client_scopes",
    {
      description:
        "List the realm's client scopes. A client scope is a reusable bundle of protocol mappers " +
        "and role scope — it's what decides which claims end up in a token.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) => wrap(() => client.get(client.realmPath(realm, "/client-scopes"))),
  );

  server.registerTool(
    "keycloak_get_client_scope",
    {
      description: "Get one client scope with its protocol mappers.",
      inputSchema: { realm: realmArg, scopeId: z.string().min(1).describe("Client scope UUID.") },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, scopeId }) =>
      wrap(() => client.get(client.realmPath(realm, `/client-scopes/${scopeId}`))),
  );

  server.registerTool(
    "keycloak_get_client_assigned_scopes",
    {
      description:
        "Show which client scopes are assigned to a client, split into default (always applied) " +
        "and optional (applied only when the request asks for them).",
      inputSchema: { realm: realmArg, clientUuid: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(async () => {
        const base = client.realmPath(realm, `/clients/${clientUuid}`);
        const [defaultScopes, optionalScopes] = await Promise.all([
          client.get(`${base}/default-client-scopes`),
          client.get(`${base}/optional-client-scopes`),
        ]);
        return { defaultScopes, optionalScopes };
      }),
  );

  server.registerTool(
    "keycloak_list_protocol_mappers",
    {
      description:
        "List the protocol mappers on a client or on a client scope. Mappers are what put claims " +
        "into a token (a user attribute, group membership, an audience, a hardcoded value).",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().optional().describe("Client UUID. Pass this OR `scopeId`."),
        scopeId: z.string().optional().describe("Client scope UUID. Pass this OR `clientUuid`."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() => {
        const { realm, clientUuid, scopeId } = oneOwner(args);
        return client.get(
          `${ownerPath(client, realm, clientUuid, scopeId)}/protocol-mappers/models`,
        );
      }),
  );

  server.registerTool(
    "keycloak_evaluate_client_scopes",
    {
      description:
        "Generate the access token a client would actually issue, without logging anyone in. " +
        "The direct way to answer 'why is this claim missing from my JWT?'.",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().min(1),
        scope: z.string().optional().describe("Space-separated optional scopes to include."),
        userId: z
          .string()
          .optional()
          .describe("Evaluate as this user (their claims are filled in)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid, scope, userId }) =>
      wrap(() =>
        client.get(
          client.realmPath(realm, `/clients/${clientUuid}/evaluate-scopes/generated-access-token`),
          compact({ scope, userId }),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_client_scope",
    {
      description: "Create a client scope. Returns its new UUID.",
      inputSchema: {
        realm: realmArg,
        name: z.string().min(1),
        protocol: z.enum(["openid-connect", "saml"]).default("openid-connect"),
        description: z.string().optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        representation: representationArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, representation, ...fields }) =>
      wrap(() =>
        client.post(client.realmPath(realm, "/client-scopes"), {
          ...compact(fields),
          ...representation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_update_client_scope",
    {
      description: "Update a client scope.",
      inputSchema: {
        realm: realmArg,
        scopeId: z.string().min(1),
        representation: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, scopeId, representation }) =>
      wrap(() => client.put(client.realmPath(realm, `/client-scopes/${scopeId}`), representation)),
  );

  server.registerTool(
    "keycloak_delete_client_scope",
    {
      description:
        "Delete a client scope. Every client using it loses the claims it contributed — tokens " +
        "silently start coming out without them.",
      inputSchema: { realm: realmArg, scopeId: z.string().min(1), confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, scopeId }) =>
      wrap(() => client.del(client.realmPath(realm, `/client-scopes/${scopeId}`))),
  );

  server.registerTool(
    "keycloak_assign_client_scope",
    {
      description:
        "Assign a client scope to a client, as default (always applied) or optional " +
        "(applied only when requested via the `scope` parameter).",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().min(1),
        scopeId: z.string().min(1),
        kind: z.enum(["default", "optional"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, clientUuid, scopeId, kind }) =>
      wrap(() =>
        client.put(
          client.realmPath(realm, `/clients/${clientUuid}/${kind}-client-scopes/${scopeId}`),
        ),
      ),
  );

  server.registerTool(
    "keycloak_unassign_client_scope",
    {
      description: "Remove a client scope from a client.",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().min(1),
        scopeId: z.string().min(1),
        kind: z.enum(["default", "optional"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, clientUuid, scopeId, kind }) =>
      wrap(() =>
        client.del(
          client.realmPath(realm, `/clients/${clientUuid}/${kind}-client-scopes/${scopeId}`),
        ),
      ),
  );

  server.registerTool(
    "keycloak_create_protocol_mapper",
    {
      description:
        "Add a protocol mapper to a client or a client scope — i.e. add a claim to its tokens.",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().optional().describe("Client UUID. Pass this OR `scopeId`."),
        scopeId: z.string().optional().describe("Client scope UUID. Pass this OR `clientUuid`."),
        name: z.string().min(1),
        protocol: z.enum(["openid-connect", "saml"]).default("openid-connect"),
        protocolMapper: z
          .string()
          .min(1)
          .describe(
            "Mapper provider id. Common ones: oidc-usermodel-attribute-mapper (a user attribute), " +
              "oidc-usermodel-property-mapper (a built-in field like email), " +
              "oidc-group-membership-mapper, oidc-audience-mapper, oidc-hardcoded-claim-mapper, " +
              "oidc-usermodel-client-role-mapper.",
          ),
        config: z
          .record(z.string(), z.string())
          .describe(
            "Mapper config; all values are STRINGS, including booleans. e.g. " +
              '{"user.attribute": "department", "claim.name": "department", ' +
              '"jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "true"}.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      wrap(() => {
        const { realm, clientUuid, scopeId, ...mapper } = oneOwner(args);
        return client.post(
          `${ownerPath(client, realm, clientUuid, scopeId)}/protocol-mappers/models`,
          mapper,
        );
      }),
  );

  server.registerTool(
    "keycloak_delete_protocol_mapper",
    {
      description:
        "Remove a protocol mapper. The claim it produced disappears from every token issued " +
        "afterwards — apps relying on that claim will break.",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().optional(),
        scopeId: z.string().optional(),
        mapperId: z.string().min(1),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      wrap(() => {
        const { realm, clientUuid, scopeId, mapperId } = oneOwner(args);
        return client.del(
          `${ownerPath(client, realm, clientUuid, scopeId)}/protocol-mappers/models/${mapperId}`,
        );
      }),
  );
};
