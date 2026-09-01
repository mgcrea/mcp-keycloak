import { z } from "zod";

import { KeycloakApiError, WritesDisabledError } from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds 19-41% to every response — worst
 * on wide lists of short-keyed objects, which are exactly the replies already
 * big enough to hurt. No model needs the indentation, and every tool returns
 * through here. Files written to disk for humans stay pretty.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof KeycloakApiError) {
      return fail(err.message, { status: err.status, errors: err.errors });
    }
    if (err instanceof WritesDisabledError) {
      return fail(err.message);
    }
    if (err instanceof Error) {
      return fail(err.message);
    }
    return fail("Unknown error", err);
  }
};

/** Every tool takes an optional realm override; omitting it uses KEYCLOAK_REALM. */
export const realmArg = z
  .string()
  .optional()
  .describe("Realm to operate on. Defaults to the server's configured realm (KEYCLOAK_REALM).");

export const firstArg = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Pagination offset — index of the first result to return (0-based).");

export const maxArg = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe("Maximum number of results to return (1-500). Defaults to 50.");

export const briefArg = z
  .boolean()
  .default(true)
  .describe(
    "Return only the core fields of each item. Keep this true when listing — full " +
      "representations are large and a big realm will flood the context.",
  );

/** Destructive tools require this, so an agent can never delete something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this destructively changes Keycloak.");

/** Free-form escape hatch on create/update tools, so a field we didn't enumerate never blocks. */
export const representationArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Additional raw fields of the Keycloak representation, shallow-merged over the named " +
      "arguments above. Use for anything not covered by an explicit argument.",
  );

/** Drop undefined values so we never send `{"email": undefined}` to Keycloak. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
