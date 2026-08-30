import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import {
  summarizeAdminEvent,
  summarizeEach,
  summarizeEvent,
  summarizeSession,
} from "#/client/shape";
import { compact, confirmArg, firstArg, maxArg, realmArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

type EventsConfig = { eventsEnabled?: boolean; adminEventsEnabled?: boolean };

/**
 * Event logging is OFF by default on every Keycloak realm, and a disabled realm
 * returns `[]` rather than an error — indistinguishable from "nothing happened".
 * So when we get nothing back, check whether recording is even on and say so.
 */
const explainIfDisabled = async (
  client: KeycloakAdminClient,
  realm: string | undefined,
  kind: "user" | "admin",
  items: unknown,
): Promise<Rec> => {
  const count = Array.isArray(items) ? items.length : 0;
  const result: Rec = { count, items };
  if (count > 0) return result;

  const config = await client
    .get<EventsConfig>(client.realmPath(realm, "/events/config"))
    .catch(() => undefined);
  const enabled = kind === "user" ? config?.eventsEnabled : config?.adminEventsEnabled;
  if (config && enabled === false) {
    const flag = kind === "user" ? "eventsEnabled" : "adminEventsEnabled";
    result.hint =
      `${kind === "user" ? "User" : "Admin"} event logging is DISABLED for realm ` +
      `'${realm ?? client.defaultRealm}', so Keycloak is recording nothing and this will always ` +
      `be empty. Turn it on in Realm settings -> Sessions/Events, or with ` +
      `keycloak_update_realm {"${flag}": true}. Note there is no backfill — only events that ` +
      `occur after you enable it are recorded.`;
  }
  return result;
};

export const registerSessionTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_get_realm_session_stats",
    {
      title: "Keycloak: Get Realm Session Stats",
      description:
        "Count active sessions per client across the realm — who is logged in, and where.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) => wrap(() => client.get(client.realmPath(realm, "/client-session-stats"))),
  );

  server.registerTool(
    "keycloak_get_client_sessions",
    {
      title: "Keycloak: Get Client Sessions",
      description: "List the active user sessions for one client.",
      inputSchema: {
        realm: realmArg,
        clientUuid: z.string().min(1).describe("Client UUID (the `id` field)."),
        first: firstArg,
        max: maxArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid, first, max }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(client.realmPath(realm, `/clients/${clientUuid}/user-sessions`), {
            first,
            max,
          }),
          summarizeSession,
        ),
      ),
  );

  server.registerTool(
    "keycloak_get_client_session_count",
    {
      title: "Keycloak: Get Client Session Count",
      description: "Count the active sessions for one client.",
      inputSchema: { realm: realmArg, clientUuid: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, clientUuid }) =>
      wrap(() => client.get(client.realmPath(realm, `/clients/${clientUuid}/session-count`))),
  );

  server.registerTool(
    "keycloak_get_events_config",
    {
      title: "Keycloak: Get Events Config",
      description:
        "Show whether event logging is enabled for the realm, which event types are recorded, " +
        "and how long they are kept. Check this first if the event tools come back empty.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) => wrap(() => client.get(client.realmPath(realm, "/events/config"))),
  );

  server.registerTool(
    "keycloak_list_events",
    {
      title: "Keycloak: List Events",
      description:
        "Search user events — logins, logouts, failed logins, registrations. The way to answer " +
        "'why can't this user log in?'. Requires user event logging to be enabled on the realm.",
      inputSchema: {
        realm: realmArg,
        type: z
          .array(z.string())
          .optional()
          .describe('Event types, e.g. ["LOGIN", "LOGIN_ERROR", "LOGOUT", "REGISTER"].'),
        client: z.string().optional().describe("Filter by clientId."),
        user: z.string().optional().describe("Filter by user UUID."),
        ipAddress: z.string().optional(),
        dateFrom: z.string().optional().describe("Inclusive lower bound, as YYYY-MM-DD."),
        dateTo: z.string().optional().describe("Inclusive upper bound, as YYYY-MM-DD."),
        first: firstArg,
        max: maxArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, first, max, ...filters }) =>
      wrap(async () => {
        const events = await client.get(client.realmPath(realm, "/events"), {
          ...compact(filters),
          first,
          max,
        });
        const result = await explainIfDisabled(client, realm, "user", events);
        return { ...result, items: summarizeEach(result.items, summarizeEvent) };
      }),
  );

  server.registerTool(
    "keycloak_list_admin_events",
    {
      title: "Keycloak: List Admin Events",
      description:
        "Search admin events — the audit trail of changes made to the realm itself (who created " +
        "this user, who changed that client). Requires admin event logging to be enabled.",
      inputSchema: {
        realm: realmArg,
        operationTypes: z.array(z.enum(["CREATE", "UPDATE", "DELETE", "ACTION"])).optional(),
        resourceTypes: z
          .array(z.string())
          .optional()
          .describe('e.g. ["USER", "CLIENT", "REALM_ROLE", "GROUP"].'),
        authClient: z.string().optional().describe("Filter by the clientId that made the change."),
        authUser: z.string().optional().describe("Filter by the user UUID that made the change."),
        resourcePath: z.string().optional().describe("e.g. `users/8f3c...`."),
        dateFrom: z.string().optional().describe("Inclusive lower bound, as YYYY-MM-DD."),
        dateTo: z.string().optional().describe("Inclusive upper bound, as YYYY-MM-DD."),
        first: firstArg,
        max: maxArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, first, max, ...filters }) =>
      wrap(async () => {
        const events = await client.get(client.realmPath(realm, "/admin-events"), {
          ...compact(filters),
          first,
          max,
        });
        const result = await explainIfDisabled(client, realm, "admin", events);
        return { ...result, items: summarizeEach(result.items, summarizeAdminEvent) };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_delete_session",
    {
      title: "Keycloak: Delete Session",
      description: "Revoke one SSO session, logging that user out of it.",
      inputSchema: {
        realm: realmArg,
        sessionId: z.string().min(1).describe("Session id, from keycloak_get_user_sessions."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, sessionId }) =>
      wrap(() => client.del(client.realmPath(realm, `/sessions/${sessionId}`))),
  );

  server.registerTool(
    "keycloak_logout_all_sessions",
    {
      title: "Keycloak: Logout All Sessions",
      description:
        "LOG EVERY USER IN THE REALM OUT. All active sessions are revoked and everyone must sign " +
        "in again. Use only in response to a compromise.",
      inputSchema: { realm: realmArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ realm }) => wrap(() => client.post(client.realmPath(realm, "/logout-all"))),
  );

  server.registerTool(
    "keycloak_clear_events",
    {
      title: "Keycloak: Clear Events",
      description: "Delete the realm's stored user events. Destroys the audit trail; irreversible.",
      inputSchema: { realm: realmArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm }) => wrap(() => client.del(client.realmPath(realm, "/events"))),
  );
};
