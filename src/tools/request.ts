import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { KeycloakAdminClient } from "#/client/admin";
import { WritesDisabledError } from "#/client/errors";
import { realmArg, wrap } from "#/tools/util";

/**
 * Guard the escape hatch against being pointed somewhere it shouldn't go: at
 * another host, up out of the admin API via `..`, or at the public OIDC surface
 * (`/realms/...`), which is not the admin API and where our bearer token has no
 * business being sent.
 */
export const assertSafePath = (path: string): void => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("`path` must be a path, not an absolute URL — the server sets the host.");
  }
  if (path.split("/").includes("..")) {
    throw new Error("`path` must not contain `..` segments.");
  }
  if (/^\/?realms\//.test(path)) {
    throw new Error(
      "`/realms/...` is the public OIDC surface, not the Admin API. For admin calls use a " +
        "realm-relative path (e.g. `users`) or an absolute `/admin/...` path.",
    );
  }
};

export const registerRequestTool = (
  server: McpServer,
  client: KeycloakAdminClient,
  allowWrites: boolean,
): void => {
  const methods = allowWrites ? (["GET", "POST", "PUT", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "keycloak_request",
    {
      title: "Keycloak: Request",
      description:
        "Escape hatch: call any Keycloak Admin REST endpoint directly. Use it when no curated " +
        "tool fits — user federation components, authorization policies, organizations, " +
        "partial import/export, credentials. " +
        "`path` is relative to the realm (`users/123/credentials` resolves under " +
        "`/admin/realms/{realm}/`), or pass an absolute admin path starting with `/admin/` " +
        "(e.g. `/admin/serverinfo`). " +
        (allowWrites
          ? "Writes are ENABLED, so POST/PUT/DELETE are permitted — there is no confirmation step, " +
            "so check the path before you call it."
          : "Writes are DISABLED: only GET is permitted. Set KEYCLOAK_ALLOW_WRITES=1 to allow mutations."),
      inputSchema: z.object({
        realm: realmArg,
        method: z.enum(methods).default("GET"),
        path: z
          .string()
          .min(1)
          .describe(
            "Realm-relative path (e.g. `users/8f3c.../credentials`, `components`) or an absolute " +
              "admin path (e.g. `/admin/serverinfo`).",
          ),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters."),
        body: z.unknown().optional().describe("JSON request body, for POST/PUT/DELETE."),
      }),
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ realm, method, path, query, body }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a request that skips schema validation.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`keycloak_request with method ${method}`);
        }
        assertSafePath(path);
        const resolved = path.startsWith("/admin/")
          ? path
          : client.realmPath(realm, `/${path.replace(/^\/+/, "")}`);
        return client.request(method, resolved, { query, ...(body !== undefined ? { body } : {}) });
      }),
  );
};
