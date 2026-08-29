import { describe, expect, it } from "vitest";

import {
  inferGrantType,
  isConfigured,
  loadConfig,
  normalizeBaseUrl,
  setupInstructions,
} from "../src/config.js";

describe("normalizeBaseUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeBaseUrl("https://keycloak.rgis.dev/")).toBe("https://keycloak.rgis.dev");
  });

  it("strips a pasted admin console path", () => {
    expect(normalizeBaseUrl("https://keycloak.rgis.dev/admin/master/console/#/master")).toBe(
      "https://keycloak.rgis.dev",
    );
  });

  it("preserves a legacy /auth prefix", () => {
    // Keycloak < 17 serves both the admin API and the token endpoint under /auth.
    expect(normalizeBaseUrl("https://legacy.example.com/auth/")).toBe(
      "https://legacy.example.com/auth",
    );
  });

  it("leaves a clean url untouched", () => {
    expect(normalizeBaseUrl("  https://keycloak.rgis.dev  ")).toBe("https://keycloak.rgis.dev");
  });
});

describe("inferGrantType", () => {
  it("prefers client_credentials when a secret is set", () => {
    expect(inferGrantType({ KEYCLOAK_CLIENT_SECRET: "s3cret" } as NodeJS.ProcessEnv)).toBe(
      "client_credentials",
    );
  });

  it("falls back to the password grant", () => {
    expect(
      inferGrantType({ KEYCLOAK_USERNAME: "admin", KEYCLOAK_PASSWORD: "pw" } as NodeJS.ProcessEnv),
    ).toBe("password");
  });

  it("honors an explicit override", () => {
    expect(
      inferGrantType({
        KEYCLOAK_GRANT_TYPE: "password",
        KEYCLOAK_CLIENT_SECRET: "s3cret",
      } as NodeJS.ProcessEnv),
    ).toBe("password");
  });

  it("returns undefined with no credentials", () => {
    expect(inferGrantType({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("loadConfig", () => {
  const base = { KEYCLOAK_URL: "https://keycloak.rgis.dev" };

  // These two used to assert that loadConfig throws. It deliberately no longer
  // does: a server that exits at startup surfaces in the client as a bare
  // "MCP error -32000: Connection closed" with stderr swallowed, so the message
  // explaining what to configure never reaches anyone. Missing configuration is
  // now a describable state, reported through keycloak_auth_status.
  it("does not throw when no credentials are set, so the server can still start", () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv);
    expect(cfg.grantType).toBeUndefined();
    expect(isConfigured(cfg)).toBe(false);
  });

  it("does not throw when the url is missing", () => {
    const cfg = loadConfig({ KEYCLOAK_CLIENT_SECRET: "s" } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBeUndefined();
    expect(isConfigured(cfg)).toBe(false);
  });

  it("names the missing pieces instead of failing silently", () => {
    const steps = setupInstructions(loadConfig({} as NodeJS.ProcessEnv)).join(" ");
    expect(steps).toContain("KEYCLOAK_URL");
    expect(steps).toContain("KEYCLOAK_CLIENT_SECRET");
    expect(steps).toContain("restart");
  });

  it("reports configured once url and a credential are both present", () => {
    const cfg = loadConfig({ ...base, KEYCLOAK_CLIENT_SECRET: "s3cret" } as NodeJS.ProcessEnv);
    expect(isConfigured(cfg)).toBe(true);
    expect(setupInstructions(cfg)).toEqual([]);
  });

  it("applies defaults for the client_credentials grant", () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_CLIENT_ID: "mcp",
      KEYCLOAK_CLIENT_SECRET: "s3cret",
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe("https://keycloak.rgis.dev");
    expect(cfg.realm).toBe("master");
    expect(cfg.authRealm).toBe("master");
    expect(cfg.grantType).toBe("client_credentials");
    expect(cfg.allowWrites).toBe(false);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.refreshSkewSeconds).toBe(30);
  });

  it("defaults clientId to admin-cli for the password grant", () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_USERNAME: "admin",
      KEYCLOAK_PASSWORD: "pw",
    } as NodeJS.ProcessEnv);
    expect(cfg.clientId).toBe("admin-cli");
    expect(cfg.grantType).toBe("password");
    expect(cfg.clientSecret).toBeUndefined();
  });

  it("defaults authRealm to the operating realm, but allows splitting them", () => {
    const cfg = loadConfig({
      ...base,
      KEYCLOAK_REALM: "dev",
      KEYCLOAK_CLIENT_SECRET: "s",
    } as NodeJS.ProcessEnv);
    expect(cfg.authRealm).toBe("dev");

    // Cross-realm: authenticate against master, operate on dev.
    const split = loadConfig({
      ...base,
      KEYCLOAK_REALM: "dev",
      KEYCLOAK_AUTH_REALM: "master",
      KEYCLOAK_CLIENT_SECRET: "s",
    } as NodeJS.ProcessEnv);
    expect(split.realm).toBe("dev");
    expect(split.authRealm).toBe("master");
  });

  it("rejects a client_credentials grant with no secret", () => {
    expect(() =>
      loadConfig({
        ...base,
        KEYCLOAK_GRANT_TYPE: "client_credentials",
        KEYCLOAK_CLIENT_ID: "mcp",
      } as NodeJS.ProcessEnv),
    ).toThrow(/KEYCLOAK_CLIENT_SECRET/);
  });

  it("rejects a password grant missing the password", () => {
    expect(() =>
      loadConfig({
        ...base,
        KEYCLOAK_GRANT_TYPE: "password",
        KEYCLOAK_USERNAME: "admin",
      } as NodeJS.ProcessEnv),
    ).toThrow(/KEYCLOAK_PASSWORD/);
  });

  it("parses the write flag from any truthy spelling", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      const cfg = loadConfig({
        ...base,
        KEYCLOAK_CLIENT_SECRET: "s",
        KEYCLOAK_ALLOW_WRITES: value,
      } as NodeJS.ProcessEnv);
      expect(cfg.allowWrites, `for ${value}`).toBe(true);
    }
    for (const value of ["0", "false", "", "no"]) {
      const cfg = loadConfig({
        ...base,
        KEYCLOAK_CLIENT_SECRET: "s",
        KEYCLOAK_ALLOW_WRITES: value,
      } as NodeJS.ProcessEnv);
      expect(cfg.allowWrites, `for ${value}`).toBe(false);
    }
  });
});
