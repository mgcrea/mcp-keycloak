import { describe, expect, it } from "vitest";

import {
  redactSecrets,
  summarizeClient,
  summarizeEach,
  summarizeServerInfo,
  summarizeUser,
} from "#/client/shape";
import { decodeJwtPayload, realmFromIssuer } from "#/client/token";

describe("summarizeUser", () => {
  it("keeps the identifying fields and drops the bulk", () => {
    const summary = summarizeUser({
      id: "u1",
      username: "bob",
      email: "bob@example.com",
      enabled: true,
      // The noise a real UserRepresentation carries:
      access: { manageGroupMembership: true, view: true, impersonate: true },
      disableableCredentialTypes: [],
      notBefore: 0,
      requiredActions: [],
      totp: false,
    });
    expect(summary.username).toBe("bob");
    expect(summary).not.toHaveProperty("access");
    expect(summary).not.toHaveProperty("disableableCredentialTypes");
  });
});

describe("summarizeClient", () => {
  it("keeps BOTH ids — the UUID for API calls, the clientId for humans", () => {
    const summary = summarizeClient({
      id: "3f2b-uuid",
      clientId: "admin-cli",
      enabled: true,
      publicClient: true,
      defaultClientScopes: ["web-origins", "profile", "roles"],
    });
    expect(summary.id).toBe("3f2b-uuid");
    expect(summary.clientId).toBe("admin-cli");
    expect(summary).not.toHaveProperty("defaultClientScopes");
  });
});

describe("summarizeEach", () => {
  it("maps across an array and passes non-arrays through", () => {
    expect(summarizeEach([{ id: "u1", username: "bob" }], summarizeUser)).toHaveLength(1);
    expect(summarizeEach({ error: "nope" }, summarizeUser)).toEqual({ error: "nope" });
  });
});

describe("summarizeServerInfo", () => {
  it("keeps only the useful head of the ~1MB payload", () => {
    const summary = summarizeServerInfo({
      systemInfo: { version: "26.0.5" },
      memoryInfo: { total: 1 },
      profileInfo: {},
      features: [],
      themes: { login: Array.from({ length: 50 }, () => ({})) },
      providers: { "some-spi": {} },
      protocolMapperTypes: {},
    });
    expect(summary.systemInfo).toEqual({ version: "26.0.5" });
    expect(summary).not.toHaveProperty("themes");
    expect(summary).not.toHaveProperty("providers");
    expect(summary).not.toHaveProperty("protocolMapperTypes");
  });
});

describe("redactSecrets", () => {
  it("masks a live IdP client secret, recursively", () => {
    const redacted = redactSecrets([
      {
        alias: "google",
        config: { clientId: "abc.apps.googleusercontent.com", clientSecret: "GOCSPX-real" },
      },
    ]) as { config: Record<string, string> }[];

    expect(redacted[0]?.config.clientSecret).toBe("**********");
    expect(redacted[0]?.config.clientId).toBe("abc.apps.googleusercontent.com");
  });

  it("leaves an empty secret alone", () => {
    expect(redactSecrets({ config: { clientSecret: "" } })).toEqual({
      config: { clientSecret: "" },
    });
  });
});

describe("decodeJwtPayload", () => {
  it("decodes the payload without verifying the signature", () => {
    const payload = {
      iss: "https://keycloak.rgis.dev/realms/master",
      azp: "mcp",
      resource_access: { "realm-management": { roles: ["view-users"] } },
    };
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "not-a-real-signature",
    ].join(".");

    const claims = decodeJwtPayload(jwt);
    expect(claims.azp).toBe("mcp");
    expect(claims.resource_access?.["realm-management"]?.roles).toEqual(["view-users"]);
  });

  it("rejects a non-JWT", () => {
    expect(() => decodeJwtPayload("nope")).toThrow(/JWT/);
  });
});

describe("realmFromIssuer", () => {
  it("pulls the realm out of the issuer url", () => {
    expect(realmFromIssuer("https://keycloak.rgis.dev/realms/master")).toBe("master");
    expect(realmFromIssuer("https://legacy.example.com/auth/realms/dev/")).toBe("dev");
    expect(realmFromIssuer(undefined)).toBeUndefined();
  });
});
