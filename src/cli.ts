#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { BUILD_INFO } from "#/build-info";
import { isConfigured, loadConfig, setupInstructions } from "#/config";
import { createServer } from "#/server";

const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.KEYCLOAK_DEBUG) console.error("[keycloak-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[keycloak-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[keycloak-mcp]", ...args),
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The banner is the diagnostic surface: this scrolling past is the last
  // chance anyone has to notice `writes=ENABLED` before an agent changes a realm.
  stderrLogger.warn(
    `keycloak-mcp connected (url=${config.baseUrl ?? "MISSING"}, realm=${config.realm}, ` +
      `grant=${config.grantType ?? "MISSING"}, writes=${config.allowWrites ? "ENABLED" : "disabled"})`,
  );
  if (!isConfigured(config)) {
    stderrLogger.warn("  not configured — only keycloak_auth_status is available:");
    for (const line of setupInstructions(config)) stderrLogger.warn(`  ${line}`);
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error("[keycloak-mcp] fatal:", err);
  process.exit(1);
});
