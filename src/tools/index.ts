import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { KeycloakAdminClient } from "../client/admin.js";
import type { TokenProvider } from "../client/auth.js";
import type { GrantType } from "../config.js";
import { registerAuthFlowTools } from "./auth-flows.js";
import { registerClientTools } from "./clients.js";
import { registerGroupTools } from "./groups.js";
import { registerIdentityProviderTools } from "./identity-providers.js";
import { registerRealmTools } from "./realms.js";
import { registerRequestTool } from "./request.js";
import { registerRoleTools } from "./roles.js";
import { registerScopeTools } from "./scopes.js";
import { registerSessionTools } from "./sessions.js";
import { registerUserTools } from "./users.js";

export type ToolContext = {
  tokenProvider: TokenProvider;
  /** Realm we authenticated against — where the acting account lives. */
  authRealm: string;
  grantType: GrantType;
  clientId: string;
  username?: string | undefined;
  /** Register the mutating tools too. Off by default — see KEYCLOAK_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * Register the Keycloak tools. Read tools are always registered; the write tools
 * are only registered when `allowWrites` is set, so with the flag off they are
 * not merely refused — they are invisible, and cannot be called at all.
 */
export const registerTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;
  registerRealmTools(server, client, ctx);
  registerUserTools(server, client, allowWrites);
  registerGroupTools(server, client, allowWrites);
  registerRoleTools(server, client, allowWrites);
  registerClientTools(server, client, allowWrites);
  registerSessionTools(server, client, allowWrites);
  registerScopeTools(server, client, allowWrites);
  registerIdentityProviderTools(server, client, allowWrites);
  registerAuthFlowTools(server, client, allowWrites);
  registerRequestTool(server, client, allowWrites);
};
