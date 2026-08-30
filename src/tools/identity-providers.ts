import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { redactSecrets } from "#/client/shape";
import { compact, confirmArg, realmArg, representationArg, wrap } from "#/tools/util";

const aliasArg = z
  .string()
  .min(1)
  .describe("Identity provider alias — the unique key, e.g. `google` or `corp-saml`.");

export const registerIdentityProviderTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_identity_providers",
    {
      title: "Keycloak: List Identity Providers",
      description:
        "List the realm's identity providers (external login sources: Google, GitHub, a corporate " +
        "SAML or OIDC IdP). Their client secrets are redacted.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) =>
      wrap(async () =>
        redactSecrets(await client.get(client.realmPath(realm, "/identity-provider/instances"))),
      ),
  );

  server.registerTool(
    "keycloak_get_identity_provider",
    {
      title: "Keycloak: Get Identity Provider",
      description:
        "Get one identity provider's full config — endpoints, trust settings, sync mode. " +
        "Its client secret is redacted.",
      inputSchema: { realm: realmArg, alias: aliasArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, alias }) =>
      wrap(async () =>
        redactSecrets(
          await client.get(
            client.realmPath(realm, `/identity-provider/instances/${encodeURIComponent(alias)}`),
          ),
        ),
      ),
  );

  server.registerTool(
    "keycloak_list_identity_provider_mappers",
    {
      title: "Keycloak: List Identity Provider Mappers",
      description:
        "List an identity provider's mappers — the rules translating claims from the external IdP " +
        "into Keycloak users, roles and groups.",
      inputSchema: { realm: realmArg, alias: aliasArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, alias }) =>
      wrap(() =>
        client.get(
          client.realmPath(
            realm,
            `/identity-provider/instances/${encodeURIComponent(alias)}/mappers`,
          ),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_identity_provider",
    {
      title: "Keycloak: Create Identity Provider",
      description: "Add an external identity provider to the realm.",
      inputSchema: {
        realm: realmArg,
        alias: aliasArg,
        providerId: z
          .string()
          .min(1)
          .describe(
            "Provider type: `oidc` or `saml` for a generic IdP, or a social one such as " +
              "`google`, `github`, `gitlab`, `microsoft`, `facebook`.",
          ),
        displayName: z.string().optional(),
        enabled: z.boolean().default(true),
        config: z
          .record(z.string(), z.string())
          .describe(
            "Provider config; all values are STRINGS. For `oidc`: clientId, clientSecret, " +
              "authorizationUrl, tokenUrl, (or use `discoveryEndpoint` to autodiscover them). " +
              "For a social provider: usually just clientId and clientSecret.",
          ),
        representation: representationArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, representation, ...fields }) =>
      wrap(() =>
        client.post(client.realmPath(realm, "/identity-provider/instances"), {
          ...compact(fields),
          ...representation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_update_identity_provider",
    {
      title: "Keycloak: Update Identity Provider",
      description: "Update an identity provider's configuration.",
      inputSchema: {
        realm: realmArg,
        alias: aliasArg,
        representation: z
          .record(z.string(), z.unknown())
          .describe("Partial IdentityProviderRepresentation."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, alias, representation }) =>
      wrap(() =>
        client.put(
          client.realmPath(realm, `/identity-provider/instances/${encodeURIComponent(alias)}`),
          { alias, ...representation },
        ),
      ),
  );

  server.registerTool(
    "keycloak_delete_identity_provider",
    {
      title: "Keycloak: Delete Identity Provider",
      description:
        "Remove an identity provider. Every user who signs in through it immediately loses the " +
        "ability to log in.",
      inputSchema: { realm: realmArg, alias: aliasArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, alias }) =>
      wrap(() =>
        client.del(
          client.realmPath(realm, `/identity-provider/instances/${encodeURIComponent(alias)}`),
        ),
      ),
  );

  server.registerTool(
    "keycloak_create_identity_provider_mapper",
    {
      title: "Keycloak: Create Identity Provider Mapper",
      description:
        "Add a mapper to an identity provider — e.g. grant a role to everyone arriving from it, " +
        "or copy an external claim onto the Keycloak user.",
      inputSchema: {
        realm: realmArg,
        alias: aliasArg,
        name: z.string().min(1),
        identityProviderMapper: z
          .string()
          .min(1)
          .describe(
            "Mapper type, e.g. `oidc-user-attribute-idp-mapper`, `oidc-role-idp-mapper`, " +
              "`oidc-hardcoded-role-idp-mapper`, `oidc-advanced-group-idp-mapper`.",
          ),
        config: z.record(z.string(), z.string()).describe("Mapper config; all values are STRINGS."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, alias, name, identityProviderMapper, config }) =>
      wrap(() =>
        client.post(
          client.realmPath(
            realm,
            `/identity-provider/instances/${encodeURIComponent(alias)}/mappers`,
          ),
          { name, identityProviderMapper, identityProviderAlias: alias, config },
        ),
      ),
  );
};
