import { z } from "zod";

export const GRANT_TYPES = ["client_credentials", "password"] as const;
export type GrantType = (typeof GRANT_TYPES)[number];

const ConfigSchema = z
  .object({
    baseUrl: z
      .url("KEYCLOAK_URL must be a valid URL, e.g. https://keycloak.example.com")
      .optional(),
    realm: z.string().min(1).default("master"),
    authRealm: z.string().min(1).default("master"),
    clientId: z.string().min(1).default("admin-cli"),
    clientSecret: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    /** Undefined when nothing is configured — see the note on loadConfig. */
    grantType: z.enum(GRANT_TYPES).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    refreshSkewSeconds: z.number().int().nonnegative().max(300).default(30),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.grantType === "client_credentials" && !cfg.clientSecret) {
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message:
          "KEYCLOAK_CLIENT_SECRET is required for the client_credentials grant. " +
          "Set it, or use the password grant with KEYCLOAK_USERNAME + KEYCLOAK_PASSWORD.",
      });
    }
    if (cfg.grantType === "password" && !(cfg.username && cfg.password)) {
      ctx.addIssue({
        code: "custom",
        path: ["username"],
        message:
          "KEYCLOAK_USERNAME and KEYCLOAK_PASSWORD are both required for the password grant.",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Normalize a Keycloak base URL: strip a trailing slash and any admin-console
 * path someone pasted out of their browser.
 *   "https://kc.example.com/admin/master/console/#/master" -> "https://kc.example.com"
 *   "https://kc.example.com/"                              -> "https://kc.example.com"
 *
 * A legacy `/auth` prefix (Keycloak < 17) is deliberately PRESERVED — those
 * servers serve both the admin API and the token endpoint under it.
 */
export const normalizeBaseUrl = (raw: string): string => {
  let url = raw.trim();
  url = url.replace(/\/admin(\/.*)?$/, "");
  url = url.replace(/\/+$/, "");
  return url;
};

/**
 * Pick the OAuth grant from whichever credentials are present. An explicit
 * KEYCLOAK_GRANT_TYPE always wins; otherwise a client secret means the
 * service-account (client_credentials) path, and a username/password pair means
 * the direct-access-grant (password) path.
 */
export const inferGrantType = (env: NodeJS.ProcessEnv): GrantType | undefined => {
  const explicit = env.KEYCLOAK_GRANT_TYPE?.trim();
  if (explicit) return explicit as GrantType;
  if (env.KEYCLOAK_CLIENT_SECRET?.trim()) return "client_credentials";
  if (env.KEYCLOAK_USERNAME?.trim() && env.KEYCLOAK_PASSWORD?.trim()) return "password";
  return undefined;
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const parseBool = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/**
 * Never throws for "nothing is configured".
 *
 * An MCP server that exits at startup shows up in the client as a bare
 * `MCP error -32000: Connection closed`, with stderr swallowed — so the one
 * message that would have explained what to set never reaches anyone. The
 * server stays up instead, registers keycloak_auth_status, and reports the gap
 * as data the caller can act on.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const grantType = inferGrantType(env);
  const rawUrl = trimmed(env.KEYCLOAK_URL);
  const realm = trimmed(env.KEYCLOAK_REALM) ?? "master";
  return ConfigSchema.parse({
    baseUrl: rawUrl ? normalizeBaseUrl(rawUrl) : undefined,
    realm,
    // Authenticate against the realm that holds the service account / admin user.
    // Defaults to the realm we operate on.
    authRealm: trimmed(env.KEYCLOAK_AUTH_REALM) ?? realm,
    clientId: trimmed(env.KEYCLOAK_CLIENT_ID),
    clientSecret: trimmed(env.KEYCLOAK_CLIENT_SECRET),
    username: trimmed(env.KEYCLOAK_USERNAME),
    password: trimmed(env.KEYCLOAK_PASSWORD),
    grantType,
    allowWrites: parseBool(env.KEYCLOAK_ALLOW_WRITES),
    maxRetries: parseIntOpt(env.KEYCLOAK_MAX_RETRIES),
    refreshSkewSeconds: parseIntOpt(env.KEYCLOAK_REFRESH_SKEW_SECONDS),
  });
};

/** True once the server has everything it needs to call the Admin API. */
export const isConfigured = (config: Config): boolean =>
  Boolean(config.baseUrl) &&
  (config.grantType === "client_credentials"
    ? Boolean(config.clientSecret)
    : config.grantType === "password"
      ? Boolean(config.username && config.password)
      : false);

/**
 * Returned by keycloak_auth_status and printed to stderr at startup. Prose
 * rather than a code, because this is the text someone acts on when nothing
 * works.
 */
export const setupInstructions = (config: Config): string[] => {
  const steps: string[] = [];
  if (!config.baseUrl) {
    steps.push("Set KEYCLOAK_URL to your Keycloak base URL, e.g. https://keycloak.example.com.");
  }
  if (!config.grantType) {
    steps.push(
      "Set KEYCLOAK_CLIENT_SECRET for the client_credentials grant (recommended: a service " +
        "account on a confidential client with the realm-management roles you need), or " +
        "KEYCLOAK_USERNAME + KEYCLOAK_PASSWORD for the password grant.",
    );
  } else if (config.grantType === "client_credentials" && !config.clientSecret) {
    steps.push("KEYCLOAK_GRANT_TYPE is client_credentials but KEYCLOAK_CLIENT_SECRET is unset.");
  } else if (config.grantType === "password" && !(config.username && config.password)) {
    steps.push(
      "KEYCLOAK_GRANT_TYPE is password but KEYCLOAK_USERNAME / KEYCLOAK_PASSWORD are unset.",
    );
  }
  if (steps.length > 0) steps.push("Then restart the server.");
  return steps;
};
