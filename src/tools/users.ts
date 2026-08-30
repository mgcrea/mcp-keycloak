import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Created, KeycloakAdminClient } from "#/client/admin";
import { summarizeEach, summarizeSession, summarizeUser } from "#/client/shape";
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

const userIdArg = z
  .string()
  .min(1)
  .describe("User UUID (the `id` field), NOT the username. Find it with keycloak_list_users.");

// The three ways to search users are routinely confused, and getting it wrong is
// the #1 cause of "the user exists but the list came back empty".
const searchArgs = {
  search: z
    .string()
    .optional()
    .describe(
      "Infix search across username, first name, last name and email. " +
        'A prefix match by default; wrap in quotes ("bob") for an exact match.',
    ),
  username: z
    .string()
    .optional()
    .describe("Filter by username. Pair with `exact` for an exact match."),
  email: z.string().optional().describe("Filter by email. Pair with `exact` for an exact match."),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  exact: z
    .boolean()
    .optional()
    .describe("Make `username`/`email`/`firstName`/`lastName` exact rather than prefix matches."),
  enabled: z.boolean().optional().describe("Only enabled (true) or only disabled (false) users."),
  emailVerified: z.boolean().optional(),
  q: z
    .string()
    .optional()
    .describe(
      "Search custom user ATTRIBUTES: space-separated key:value pairs, e.g. " +
        '"department:sales tier:gold". This is the only way to filter on attributes.',
    ),
};

export const registerUserTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_users",
    {
      title: "Keycloak: List Users",
      description:
        "Search users in a realm. Use `search` for a loose match across name/username/email, " +
        "`username`/`email` + `exact` for a precise lookup, or `q` to match custom attributes.",
      inputSchema: {
        realm: realmArg,
        ...searchArgs,
        idpAlias: z
          .string()
          .optional()
          .describe("Only users federated from this identity provider."),
        first: firstArg,
        max: maxArg,
        briefRepresentation: briefArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, first, max, briefRepresentation, ...filters }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(client.realmPath(realm, "/users"), {
            ...compact(filters),
            first,
            max,
            briefRepresentation,
          }),
          summarizeUser,
        ),
      ),
  );

  server.registerTool(
    "keycloak_count_users",
    {
      title: "Keycloak: Count Users",
      description: "Count users matching a filter, without fetching them.",
      inputSchema: { realm: realmArg, ...searchArgs },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, ...filters }) =>
      wrap(async () => ({
        // This endpoint returns a bare JSON number, not an object.
        count: await client.get<number>(client.realmPath(realm, "/users/count"), compact(filters)),
      })),
  );

  server.registerTool(
    "keycloak_get_user",
    {
      title: "Keycloak: Get User",
      description: "Get one user's full representation, including custom attributes.",
      inputSchema: { realm: realmArg, userId: userIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, userId }) =>
      wrap(() => client.get(client.realmPath(realm, `/users/${userId}`))),
  );

  server.registerTool(
    "keycloak_get_user_groups",
    {
      title: "Keycloak: Get User Groups",
      description: "List the groups a user belongs to.",
      inputSchema: { realm: realmArg, userId: userIdArg, first: firstArg, max: maxArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, userId, first, max }) =>
      wrap(() => client.get(client.realmPath(realm, `/users/${userId}/groups`), { first, max })),
  );

  server.registerTool(
    "keycloak_get_user_role_mappings",
    {
      title: "Keycloak: Get User Role Mappings",
      description:
        "Get a user's role mappings. By default returns only roles assigned DIRECTLY to the user; " +
        "set `effective` to also include roles inherited from groups and from composite roles — " +
        "that is the set that actually lands in their token.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        effective: z
          .boolean()
          .default(false)
          .describe("Include roles inherited via groups and composites."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, userId, effective }) =>
      wrap(() =>
        client.get(
          client.realmPath(
            realm,
            effective
              ? `/users/${userId}/role-mappings/realm/composite`
              : `/users/${userId}/role-mappings`,
          ),
        ),
      ),
  );

  server.registerTool(
    "keycloak_get_user_sessions",
    {
      title: "Keycloak: Get User Sessions",
      description: "List a user's active SSO sessions (where and when they are logged in).",
      inputSchema: { realm: realmArg, userId: userIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, userId }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(client.realmPath(realm, `/users/${userId}/sessions`)),
          summarizeSession,
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_user",
    {
      title: "Keycloak: Create User",
      description:
        "Create a user. Returns the new user's id (Keycloak reports it in the Location header). " +
        "Pass `temporaryPassword` to set an initial password the user must change at first login.",
      inputSchema: {
        realm: realmArg,
        username: z.string().min(1),
        email: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        enabled: z.boolean().default(true),
        emailVerified: z.boolean().optional(),
        attributes: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Custom attributes; values are arrays, e.g. {"department": ["sales"]}.'),
        groups: z
          .array(z.string())
          .optional()
          .describe('Group PATHS to join at creation, e.g. ["/engineering/backend"].'),
        requiredActions: z
          .array(z.enum(["UPDATE_PASSWORD", "VERIFY_EMAIL", "UPDATE_PROFILE", "CONFIGURE_TOTP"]))
          .optional()
          .describe("Actions the user must complete at next login."),
        temporaryPassword: z
          .string()
          .optional()
          .describe("Initial password. Set as temporary — the user is forced to change it."),
        representation: representationArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, temporaryPassword, representation, ...fields }) =>
      wrap(async () => {
        const created = await client.post<Created>(client.realmPath(realm, "/users"), {
          ...compact(fields),
          ...representation,
        });
        if (temporaryPassword && created.id) {
          await client.put(client.realmPath(realm, `/users/${created.id}/reset-password`), {
            type: "password",
            value: temporaryPassword,
            temporary: true,
          });
          return { ...created, passwordSet: true, passwordTemporary: true };
        }
        return created;
      }),
  );

  server.registerTool(
    "keycloak_update_user",
    {
      title: "Keycloak: Update User",
      description:
        "Update a user. Only the fields you pass are changed. Note that `attributes` REPLACES " +
        "the whole attribute map rather than merging into it — read the user first if you mean to add one.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        representation: z
          .record(z.string(), z.unknown())
          .describe('Partial UserRepresentation, e.g. {"enabled": false} or {"email": "a@b.com"}.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, userId, representation }) =>
      wrap(() => client.put(client.realmPath(realm, `/users/${userId}`), representation)),
  );

  server.registerTool(
    "keycloak_delete_user",
    {
      title: "Keycloak: Delete User",
      description: "Permanently delete a user. Irreversible.",
      inputSchema: { realm: realmArg, userId: userIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, userId }) =>
      wrap(() => client.del(client.realmPath(realm, `/users/${userId}`))),
  );

  server.registerTool(
    "keycloak_reset_user_password",
    {
      title: "Keycloak: Reset User Password",
      description:
        "Set a user's password, overwriting the existing one. Prefer " +
        "keycloak_send_user_action_email with UPDATE_PASSWORD when the user has a mailbox — " +
        "it avoids the password ever passing through this conversation.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        password: z.string().min(1),
        temporary: z
          .boolean()
          .default(true)
          .describe("Force the user to change it at next login. Defaults to true."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, userId, password, temporary }) =>
      wrap(() =>
        client.put(client.realmPath(realm, `/users/${userId}/reset-password`), {
          type: "password",
          value: password,
          temporary,
        }),
      ),
  );

  server.registerTool(
    "keycloak_send_user_action_email",
    {
      title: "Keycloak: Send User Action Email",
      description:
        "Email the user a link that makes them perform actions — reset their password, verify " +
        "their email, set up TOTP. Requires SMTP to be configured on the realm.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        actions: z
          .array(z.enum(["UPDATE_PASSWORD", "VERIFY_EMAIL", "UPDATE_PROFILE", "CONFIGURE_TOTP"]))
          .min(1),
        lifespan: z.number().int().positive().optional().describe("Link validity, in seconds."),
        clientId: z.string().optional().describe("Client the user is redirected back to."),
        redirectUri: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, userId, actions, lifespan, clientId, redirectUri }) =>
      wrap(() =>
        client.put(
          client.realmPath(realm, `/users/${userId}/execute-actions-email`),
          actions,
          compact({ lifespan, client_id: clientId, redirect_uri: redirectUri }),
        ),
      ),
  );

  server.registerTool(
    "keycloak_set_user_groups",
    {
      title: "Keycloak: Set User Groups",
      description: "Add a user to a group, or remove them from it.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        groupId: z.string().min(1).describe("Group UUID. See keycloak_list_groups."),
        action: actionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, userId, groupId, action }) =>
      wrap(() => {
        const path = client.realmPath(realm, `/users/${userId}/groups/${groupId}`);
        return action === "add" ? client.put(path) : client.del(path);
      }),
  );

  server.registerTool(
    "keycloak_set_user_realm_roles",
    {
      title: "Keycloak: Set User Realm Roles",
      description: "Grant realm roles to a user, or revoke them.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        roleNames: roleNamesArg,
        action: actionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, userId, roleNames, action }) =>
      wrap(async () => {
        const roles = await resolveRoles(client, realm, roleNames);
        const path = client.realmPath(realm, `/users/${userId}/role-mappings/realm`);
        // Both add and remove take the full role representations in the body —
        // the remove is a DELETE *with* a body.
        await (action === "add" ? client.post(path, roles) : client.del(path, roles));
        return { action, roles: roleNames };
      }),
  );

  server.registerTool(
    "keycloak_set_user_client_roles",
    {
      title: "Keycloak: Set User Client Roles",
      description:
        "Grant a client's roles to a user, or revoke them. This is how you grant admin rights: " +
        "assign `realm-management` roles (e.g. manage-users, view-clients) from that client.",
      inputSchema: {
        realm: realmArg,
        userId: userIdArg,
        clientUuid: z.string().min(1).describe("Client UUID (the `id` field), not the clientId."),
        roleNames: roleNamesArg,
        action: actionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, userId, clientUuid, roleNames, action }) =>
      wrap(async () => {
        const roles = await resolveRoles(client, realm, roleNames, clientUuid);
        const path = client.realmPath(
          realm,
          `/users/${userId}/role-mappings/clients/${clientUuid}`,
        );
        await (action === "add" ? client.post(path, roles) : client.del(path, roles));
        return { action, clientUuid, roles: roleNames };
      }),
  );

  server.registerTool(
    "keycloak_logout_user",
    {
      title: "Keycloak: Logout User",
      description: "Log a user out of every session. They must sign in again.",
      inputSchema: { realm: realmArg, userId: userIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, userId }) =>
      wrap(() => client.post(client.realmPath(realm, `/users/${userId}/logout`))),
  );
};
