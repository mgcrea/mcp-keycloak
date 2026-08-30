import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { compact, confirmArg, realmArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

const flowAliasArg = z
  .string()
  .min(1)
  .describe("Flow alias (its name), e.g. `browser` or `direct grant`.");

export const registerAuthFlowTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "keycloak_list_authentication_flows",
    {
      title: "Keycloak: List Authentication Flows",
      description:
        "List the realm's authentication flows — the step-by-step login pipelines (browser, " +
        "direct grant, registration, reset credentials).",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) => wrap(() => client.get(client.realmPath(realm, "/authentication/flows"))),
  );

  server.registerTool(
    "keycloak_get_authentication_flow_executions",
    {
      title: "Keycloak: Get Authentication Flow Executions",
      description:
        "Get the ordered steps inside a flow and whether each is REQUIRED, ALTERNATIVE, " +
        "CONDITIONAL or DISABLED. This is what determines what a user is actually asked for " +
        "when logging in (password, OTP, ...).",
      inputSchema: { realm: realmArg, flowAlias: flowAliasArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm, flowAlias }) =>
      wrap(() =>
        client.get(
          client.realmPath(
            realm,
            `/authentication/flows/${encodeURIComponent(flowAlias)}/executions`,
          ),
        ),
      ),
  );

  server.registerTool(
    "keycloak_list_required_actions",
    {
      title: "Keycloak: List Required Actions",
      description:
        "List the realm's required actions (Update Password, Verify Email, Configure OTP) and " +
        "whether each is enabled or applied to new users by default.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) =>
      wrap(() => client.get(client.realmPath(realm, "/authentication/required-actions"))),
  );

  server.registerTool(
    "keycloak_get_realm_flow_bindings",
    {
      title: "Keycloak: Get Realm Flow Bindings",
      description:
        "Show which flow is bound to each authentication entry point of the realm — i.e. which " +
        "flow actually runs on a browser login, a direct grant, a registration, a password reset.",
      inputSchema: { realm: realmArg },
      annotations: { readOnlyHint: true },
    },
    async ({ realm }) =>
      wrap(async () => {
        const r = await client.get<Rec>(client.realmPath(realm));
        return {
          browserFlow: r.browserFlow,
          registrationFlow: r.registrationFlow,
          directGrantFlow: r.directGrantFlow,
          resetCredentialsFlow: r.resetCredentialsFlow,
          clientAuthenticationFlow: r.clientAuthenticationFlow,
          dockerAuthenticationFlow: r.dockerAuthenticationFlow,
          firstBrokerLoginFlow: r.firstBrokerLoginFlow,
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "keycloak_create_authentication_flow",
    {
      title: "Keycloak: Create Authentication Flow",
      description:
        "Create an empty authentication flow. To customise an existing one, prefer " +
        "keycloak_copy_authentication_flow — built-in flows cannot be edited in place.",
      inputSchema: {
        realm: realmArg,
        alias: z.string().min(1),
        description: z.string().optional(),
        providerId: z.enum(["basic-flow", "form-flow"]).default("basic-flow"),
        topLevel: z.boolean().default(true),
        builtIn: z.literal(false).default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, ...fields }) =>
      wrap(() => client.post(client.realmPath(realm, "/authentication/flows"), compact(fields))),
  );

  server.registerTool(
    "keycloak_copy_authentication_flow",
    {
      title: "Keycloak: Copy Authentication Flow",
      description:
        "Copy a flow under a new name. This is the supported way to customise a built-in flow: " +
        "copy `browser`, edit the copy's executions, then bind it via keycloak_update_realm " +
        '({"browserFlow": "<newName>"}).',
      inputSchema: {
        realm: realmArg,
        flowAlias: flowAliasArg,
        newName: z.string().min(1).describe("Alias for the copy."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ realm, flowAlias, newName }) =>
      wrap(() =>
        client.post(
          client.realmPath(realm, `/authentication/flows/${encodeURIComponent(flowAlias)}/copy`),
          { newName },
        ),
      ),
  );

  server.registerTool(
    "keycloak_update_authentication_execution",
    {
      title: "Keycloak: Update Authentication Execution",
      description:
        "Change one step's requirement within a flow — e.g. set the OTP Form to REQUIRED to force " +
        "MFA on every login. Get the executionId from keycloak_get_authentication_flow_executions.",
      inputSchema: {
        realm: realmArg,
        flowAlias: flowAliasArg,
        executionId: z.string().min(1).describe("The execution's `id`."),
        requirement: z.enum(["REQUIRED", "ALTERNATIVE", "DISABLED", "CONDITIONAL"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ realm, flowAlias, executionId, requirement }) =>
      wrap(() =>
        client.put(
          client.realmPath(
            realm,
            `/authentication/flows/${encodeURIComponent(flowAlias)}/executions`,
          ),
          { id: executionId, requirement },
        ),
      ),
  );

  server.registerTool(
    "keycloak_delete_authentication_flow",
    {
      title: "Keycloak: Delete Authentication Flow",
      description:
        "Delete an authentication flow. If the flow is still bound to the realm, logins break. " +
        "Note this takes the flow's UUID, not its alias.",
      inputSchema: {
        realm: realmArg,
        flowId: z.string().min(1).describe("Flow UUID (the `id`), NOT the alias."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ realm, flowId }) =>
      wrap(() => client.del(client.realmPath(realm, `/authentication/flows/${flowId}`))),
  );
};
