import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/**
 * Registered unconditionally, before any credential check, so an unconfigured
 * server answers "here is what to set" instead of closing the connection with
 * its own explanation swallowed.
 */
export const registerStatusTool = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "keycloak_auth_status",
    {
      description:
        "Report whether this server has working Keycloak credentials, which realm and account " +
        "it acts as, whether writes are enabled, and — when something is missing — exactly " +
        "what to set. Call this first when a tool you expected is not listed: an absent tool " +
        "here means missing configuration rather than a bug.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        configured: ctx.configured,
        url: ctx.config.baseUrl ?? null,
        realm: ctx.config.realm,
        authRealm: ctx.authRealm,
        grantType: ctx.grantType ?? null,
        clientId: ctx.clientId,
        ...(ctx.username ? { username: ctx.username } : {}),
        writes: ctx.allowWrites ? "enabled" : "disabled",
        setup: setupInstructions(ctx.config),
      })),
  );
};
