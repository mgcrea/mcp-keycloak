import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { KeycloakAdminClient } from "#/client/admin";
import { createTokenProvider, type Logger, type TokenProvider } from "#/client/auth";
import { isConfigured, type Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-keycloak-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests). */
  tokenProvider?: TokenProvider;
};

export type CreatedServer = {
  server: McpServer;
  client: KeycloakAdminClient;
  tokenProvider: TokenProvider;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const tokenProvider =
    opts.tokenProvider ??
    createTokenProvider({
      credentials: {
        // Placeholders when unconfigured: the token provider is built either
        // way so `createServer` stays total, but no credential-requiring tool
        // is registered, so it is never actually asked for a token.
        baseUrl: config.baseUrl ?? "",
        authRealm: config.authRealm,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        username: config.username,
        password: config.password,
        grantType: config.grantType ?? "client_credentials",
      },
      refreshSkewSeconds: config.refreshSkewSeconds,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const client = new KeycloakAdminClient({
    baseUrl: config.baseUrl ?? "",
    tokenProvider,
    defaultRealm: config.realm,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, {
    config,
    configured: isConfigured(config),
    tokenProvider,
    authRealm: config.authRealm,
    grantType: config.grantType,
    clientId: config.clientId,
    username: config.username,
    allowWrites: config.allowWrites,
  });
  return { server, client, tokenProvider };
};
