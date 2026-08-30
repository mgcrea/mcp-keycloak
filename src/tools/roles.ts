import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { summarizeEach, summarizeUser } from "#/client/shape";
import {
  briefArg,
  compact,
  confirmArg,
  firstArg,
  maxArg,
  realmArg,
  representationArg,
  wrap,
} from "#/tools/util";

type Rec = Record<string, unknown>;

export const roleNamesArg = z
  .array(z.string().min(1))
  .min(1)
  .describe('Role names, e.g. ["offline_access", "default-roles-master"].');

export const actionArg = z
  .enum(["add", "remove"])
  .describe("Whether to add these roles to the mapping or remove them from it.");

/**
 * Keycloak's role-mapping endpoints take an array of full RoleRepresentation
 * objects, NOT role names — pass names and it silently no-ops. So resolve each
 * name to its representation first, and fail loudly on the ones that don't exist.
 */
export const resolveRoles = async (
  client: KeycloakAdminClient,
  realm: string | undefined,
  names: string[],
  clientUuid?: string,
): Promise<Rec[]> => {
  const path = (name: string): string =>
    clientUuid
      ? client.realmPath(realm, `/clients/${clientUuid}/roles/${encodeURIComponent(name)}`)
      : client.realmPath(realm, `/roles/${encodeURIComponent(name)}`);

  const settled = await Promise.allSettled(names.map((name) => client.get<Rec>(path(name))));
  const missing = names.filter((_, i) => settled[i]?.status === "rejected");
  if (missing.length > 0) {
    const where = clientUuid ? `client ${clientUuid}` : `realm '${realm ?? client.defaultRealm}'`;
    throw new Error(
      `Role(s) not found in ${where}: ${missing.join(", ")}. ` +
        `List the available roles with ${clientUuid ? "keycloak_list_client_roles" : "keycloak_list_realm_roles"}.`,
    );
  }
  return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
};

export const registerRoleTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_realm_roles",
    {
      title: "Keycloak: List Realm Roles",
      description: "List the realm-level roles defined in a realm.",
      inputSchema: z.object({
        realm: realmArg,
        search: z.string().optional().describe("Filter roles by name (infix match)."),
        first: firstArg,
        max: maxArg,
        briefRepresentation: briefArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ realm, search, first, max, briefRepresentation }) =>
      wrap(() =>
        client.get(client.realmPath(realm, "/roles"), {
          search,
          first,
          max,
          briefRepresentation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_get_realm_role",
    {
      title: "Keycloak: Get Realm Role",
      description: "Get one realm role by name, with its attributes and composite flag.",
      inputSchema: z.object({
        realm: realmArg,
        roleName: z.string().min(1).describe("Role NAME (realm roles are addressed by name)."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ realm, roleName }) =>
      wrap(() => client.get(client.realmPath(realm, `/roles/${encodeURIComponent(roleName)}`))),
  );

  server.registerTool(
    "keycloak_get_realm_role_members",
    {
      title: "Keycloak: Get Realm Role Members",
      description: "List the users who have a given realm role — i.e. 'who has this role?'.",
      inputSchema: z.object({
        realm: realmArg,
        roleName: z.string().min(1),
        first: firstArg,
        max: maxArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ realm, roleName, first, max }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(
            client.realmPath(realm, `/roles/${encodeURIComponent(roleName)}/users`),
            { first, max },
          ),
          summarizeUser,
        ),
      ),
  );

  server.registerTool(
    "keycloak_get_role_composites",
    {
      title: "Keycloak: Get Role Composites",
      description:
        "List the roles contained in a composite role. Takes the role's UUID (not its name) — " +
        "get it from keycloak_get_realm_role.",
      inputSchema: z.object({
        realm: realmArg,
        roleId: z.string().min(1).describe("Role UUID, from the `id` field of a role."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ realm, roleId }) =>
      wrap(() => client.get(client.realmPath(realm, `/roles-by-id/${roleId}/composites`))),
  );

  server.registerTool(
    "keycloak_list_client_roles",
    {
      title: "Keycloak: List Client Roles",
      description:
        "List the roles defined by a client. Note these are distinct from realm roles — " +
        "`realm-management`'s roles (view-users, manage-users, ...) are client roles.",
      inputSchema: z.object({
        realm: realmArg,
        clientUuid: z
          .string()
          .min(1)
          .describe(
            "Client UUID (the `id` field), NOT the clientId string. See keycloak_list_clients.",
          ),
        search: z.string().optional(),
        first: firstArg,
        max: maxArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid, search, first, max }) =>
      wrap(() =>
        client.get(client.realmPath(realm, `/clients/${clientUuid}/roles`), {
          search,
          first,
          max,
        }),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_realm_role",
    {
      title: "Keycloak: Create Realm Role",
      description: "Create a realm-level role.",
      inputSchema: z.object({
        realm: realmArg,
        name: z.string().min(1),
        description: z.string().optional(),
        attributes: z.record(z.string(), z.array(z.string())).optional(),
        representation: representationArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, name, description, attributes, representation }) =>
      wrap(() =>
        client.post(client.realmPath(realm, "/roles"), {
          ...compact({ name, description, attributes }),
          ...representation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_update_realm_role",
    {
      title: "Keycloak: Update Realm Role",
      description: "Update a realm role's description or attributes.",
      inputSchema: z.object({
        realm: realmArg,
        roleName: z.string().min(1),
        representation: z.record(z.string(), z.unknown()).describe("Partial RoleRepresentation."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, roleName, representation }) =>
      wrap(() =>
        client.put(client.realmPath(realm, `/roles/${encodeURIComponent(roleName)}`), {
          name: roleName,
          ...representation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_delete_realm_role",
    {
      title: "Keycloak: Delete Realm Role",
      description:
        "Delete a realm role. It is removed from every user and group that had it — those " +
        "users immediately lose whatever access the role granted.",
      inputSchema: z.object({ realm: realmArg, roleName: z.string().min(1), confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, roleName }) =>
      wrap(() => client.del(client.realmPath(realm, `/roles/${encodeURIComponent(roleName)}`))),
  );

  server.registerTool(
    "keycloak_create_client_role",
    {
      title: "Keycloak: Create Client Role",
      description: "Create a role on a client.",
      inputSchema: z.object({
        realm: realmArg,
        clientUuid: z.string().min(1).describe("Client UUID (the `id` field), not the clientId."),
        name: z.string().min(1),
        description: z.string().optional(),
        representation: representationArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, clientUuid, name, description, representation }) =>
      wrap(() =>
        client.post(client.realmPath(realm, `/clients/${clientUuid}/roles`), {
          ...compact({ name, description }),
          ...representation,
        }),
      ),
  );
};
