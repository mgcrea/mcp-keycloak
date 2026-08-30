import type { McpServer } from "@modelcontextprotocol/server";

import type { KeycloakAdminClient } from "#/client/admin";
import type { TokenProvider } from "#/client/auth";
import type { Config, GrantType } from "#/config";
import { registerAuthFlowTools } from "#/tools/auth-flows";
import { registerClientTools } from "#/tools/clients";
import { registerGroupTools } from "#/tools/groups";
import { registerIdentityProviderTools } from "#/tools/identity-providers";
import { registerRealmTools } from "#/tools/realms";
import { registerRequestTool } from "#/tools/request";
import { registerRoleTools } from "#/tools/roles";
import { registerScopeTools } from "#/tools/scopes";
import { registerSessionTools } from "#/tools/sessions";
import { registerStatusTool } from "#/tools/status";
import { registerUserTools } from "#/tools/users";

export type ToolContext = {
  config: Config;
  /** False when credentials or KEYCLOAK_URL are missing. */
  configured: boolean;
  tokenProvider: TokenProvider;
  /** Realm we authenticated against — where the acting account lives. */
  authRealm: string;
  grantType: GrantType | undefined;
  clientId: string;
  username?: string | undefined;
  /** Register the mutating tools too. Off by default — see KEYCLOAK_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * Register the Keycloak tools.
 *
 * keycloak_auth_status comes first and unconditionally, so an unconfigured
 * server is still a useful one — it can say what to set — rather than a
 * connection that closes. Everything else needs real credentials.
 *
 * Read tools are then always registered; the write tools only when
 * `allowWrites` is set, so with the flag off they are not merely refused —
 * they are invisible, and cannot be called at all.
 */
/**
 * A context that has passed the configuration check. `grantType` is only
 * optional while the server is unconfigured; narrowing it once here means the
 * downstream tools take a non-optional value instead of each defaulting it to
 * something that would be a lie.
 */
export type ConfiguredToolContext = ToolContext & { grantType: GrantType };

export const registerTools = (
  server: McpServer,
  client: KeycloakAdminClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;
  registerStatusTool(server, ctx);
  if (!ctx.configured || !ctx.grantType) return;
  const ready: ConfiguredToolContext = { ...ctx, grantType: ctx.grantType };

  registerRealmTools(server, client, ready);
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
