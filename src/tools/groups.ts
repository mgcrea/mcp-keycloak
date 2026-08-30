import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { summarizeEach, summarizeUser } from "#/client/shape";
import { actionArg, resolveRoles, roleNamesArg } from "#/tools/roles";
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

const groupIdArg = z
  .string()
  .min(1)
  .describe("Group UUID (the `id` field), not the group name or path.");

export const registerGroupTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_groups",
    {
      title: "Keycloak: List Groups",
      description:
        "List the realm's groups. Groups are a tree — top-level groups are returned with their " +
        "subGroups nested inside.",
      inputSchema: {
        realm: realmArg,
        search: z.string().optional().describe("Filter by group name."),
        exact: z.boolean().optional(),
        q: z.string().optional().describe('Search group ATTRIBUTES: "key:value key2:value2".'),
        first: firstArg,
        max: maxArg,
        briefRepresentation: briefArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, first, max, briefRepresentation, ...filters }) =>
      wrap(() =>
        client.get(client.realmPath(realm, "/groups"), {
          ...compact(filters),
          first,
          max,
          briefRepresentation,
        }),
      ),
  );

  server.registerTool(
    "keycloak_get_group",
    {
      title: "Keycloak: Get Group",
      description: "Get one group with its attributes and subgroups.",
      inputSchema: { realm: realmArg, groupId: groupIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, groupId }) =>
      wrap(() => client.get(client.realmPath(realm, `/groups/${groupId}`))),
  );

  server.registerTool(
    "keycloak_get_group_members",
    {
      title: "Keycloak: Get Group Members",
      description: "List the users in a group.",
      inputSchema: {
        realm: realmArg,
        groupId: groupIdArg,
        first: firstArg,
        max: maxArg,
        briefRepresentation: briefArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, groupId, first, max, briefRepresentation }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(client.realmPath(realm, `/groups/${groupId}/members`), {
            first,
            max,
            briefRepresentation,
          }),
          summarizeUser,
        ),
      ),
  );

  server.registerTool(
    "keycloak_get_group_role_mappings",
    {
      title: "Keycloak: Get Group Role Mappings",
      description:
        "Get the roles mapped to a group. Every member of the group inherits these roles.",
      inputSchema: { realm: realmArg, groupId: groupIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, groupId }) =>
      wrap(() => client.get(client.realmPath(realm, `/groups/${groupId}/role-mappings`))),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_group",
    {
      title: "Keycloak: Create Group",
      description:
        "Create a group. Pass `parentGroupId` to nest it under an existing group. " +
        "Returns the new group's id.",
      inputSchema: {
        realm: realmArg,
        name: z.string().min(1),
        parentGroupId: z
          .string()
          .optional()
          .describe("Create as a subgroup of this group. Omit for a top-level group."),
        attributes: z.record(z.string(), z.array(z.string())).optional(),
        representation: representationArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, name, parentGroupId, attributes, representation }) =>
      wrap(() =>
        client.post(
          client.realmPath(realm, parentGroupId ? `/groups/${parentGroupId}/children` : "/groups"),
          { ...compact({ name, attributes }), ...representation },
        ),
      ),
  );

  server.registerTool(
    "keycloak_update_group",
    {
      title: "Keycloak: Update Group",
      description: "Rename a group or change its attributes.",
      inputSchema: {
        realm: realmArg,
        groupId: groupIdArg,
        representation: z.record(z.string(), z.unknown()).describe("Partial GroupRepresentation."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, groupId, representation }) =>
      wrap(() => client.put(client.realmPath(realm, `/groups/${groupId}`), representation)),
  );

  server.registerTool(
    "keycloak_delete_group",
    {
      title: "Keycloak: Delete Group",
      description:
        "Delete a group AND all of its subgroups. Members are not deleted, but they lose every " +
        "role the group granted them.",
      inputSchema: { realm: realmArg, groupId: groupIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, groupId }) =>
      wrap(() => client.del(client.realmPath(realm, `/groups/${groupId}`))),
  );

  server.registerTool(
    "keycloak_set_group_realm_roles",
    {
      title: "Keycloak: Set Group Realm Roles",
      description:
        "Grant realm roles to a group, or revoke them. Every member inherits the group's roles.",
      inputSchema: {
        realm: realmArg,
        groupId: groupIdArg,
        roleNames: roleNamesArg,
        action: actionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, groupId, roleNames, action }) =>
      wrap(async () => {
        const roles = await resolveRoles(client, realm, roleNames);
        const path = client.realmPath(realm, `/groups/${groupId}/role-mappings/realm`);
        await (action === "add" ? client.post(path, roles) : client.del(path, roles));
        return { action, roles: roleNames };
      }),
  );
};
