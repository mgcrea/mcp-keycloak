import { describe, expect, it, vi } from "vitest";

import { KeycloakAdminClient } from "#/client/admin";
import { staticTokenProvider } from "#/client/auth";
import { describeIdentity, type DescribeIdentityOptions } from "#/client/identity";

const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

/**
 * Exactly what keycloak.rgis.dev hands back for `admin-cli`: no `sub`, no
 * username, no role claims. Reading permissions off this token yields nothing,
 * even though the account behind it is a full master-realm admin.
 */
const LIGHTWEIGHT_TOKEN = jwt({
  iss: "https://kc.example.com/realms/master",
  azp: "admin-cli",
  exp: Math.floor(Date.now() / 1000) + 60,
  scope: "email profile",
});

const FAT_TOKEN = jwt({
  iss: "https://kc.example.com/realms/master",
  azp: "mcp",
  sub: "svc-1",
  preferred_username: "service-account-mcp",
  realm_access: { roles: ["offline_access"] },
  resource_access: { "realm-management": { roles: ["view-users"] } },
});

/** Route fetches by URL so each test only declares the endpoints it cares about. */
const routed = (routes: Record<string, unknown>): ReturnType<typeof vi.fn> =>
  vi.fn(async (url: string) => {
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (!match) return new Response("[]", { status: 200 });
    const body = routes[match];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });

const options = (
  fetchImpl: ReturnType<typeof vi.fn>,
  token: string,
  overrides: Partial<DescribeIdentityOptions> = {},
): DescribeIdentityOptions => ({
  client: new KeycloakAdminClient({
    baseUrl: "https://kc.example.com",
    tokenProvider: staticTokenProvider(token),
    defaultRealm: "master",
    fetch: fetchImpl as unknown as typeof fetch,
  }),
  tokenProvider: staticTokenProvider(token),
  authRealm: "master",
  grantType: "password",
  clientId: "admin-cli",
  username: "admin",
  allowWrites: false,
  ...overrides,
});

const ADMIN_MAPPINGS = {
  realmMappings: [{ name: "admin" }, { name: "default-roles-master" }],
  clientMappings: {},
};

describe("describeIdentity with a lightweight token", () => {
  it("resolves the user by username and reads roles from the SERVER, not the token", async () => {
    const fetchImpl = routed({
      "/users?username=admin": [{ id: "u-admin" }],
      "/users/u-admin/role-mappings": ADMIN_MAPPINGS,
      "/admin/realms?": [{ realm: "master" }, { realm: "ai-hub" }],
    });

    const identity = await describeIdentity(options(fetchImpl, LIGHTWEIGHT_TOKEN));

    expect(identity.subject).toBe("u-admin");
    expect(identity.realmRoles).toEqual(["admin", "default-roles-master"]);
    expect(identity.rolesSource).toBe("role-mappings");
    expect(identity.preferredUsername).toBe("admin");
    expect(identity.accessibleRealms).toEqual(["master", "ai-hub"]);
  });

  it("does NOT cry 403 at an account whose only admin grant is the `admin` realm role", async () => {
    // The regression this file exists for: realmManagementRoles is legitimately
    // empty here, and the old code took that to mean "you will get 403s" —
    // at a full master-realm admin.
    const fetchImpl = routed({
      "/users?username=admin": [{ id: "u-admin" }],
      "/users/u-admin/role-mappings": ADMIN_MAPPINGS,
      "/admin/realms?": [{ realm: "master" }],
    });

    const identity = await describeIdentity(options(fetchImpl, LIGHTWEIGHT_TOKEN));

    expect(identity.realmManagementRoles).toEqual([]);
    expect(identity.hint).toBeUndefined();
  });

  it("resolves a service account via the client's service-account-user", async () => {
    const fetchImpl = routed({
      "/clients?clientId=mcp": [{ id: "client-uuid" }],
      "/clients/client-uuid/service-account-user": { id: "svc-user" },
      "/users/svc-user/role-mappings": {
        clientMappings: { "realm-management": { mappings: [{ name: "manage-users" }] } },
      },
      "/admin/realms?": [{ realm: "master" }],
    });

    const identity = await describeIdentity(
      options(fetchImpl, LIGHTWEIGHT_TOKEN, {
        grantType: "client_credentials",
        clientId: "mcp",
        username: undefined,
      }),
    );

    expect(identity.subject).toBe("svc-user");
    expect(identity.realmManagementRoles).toEqual(["manage-users"]);
    expect(identity.hint).toBeUndefined();
  });
});

describe("describeIdentity fallbacks", () => {
  it("falls back to token claims when role mappings can't be read", async () => {
    const fetchImpl = routed({
      "/role-mappings": new Response("{}", { status: 403 }),
      "/admin/realms?": [{ realm: "master" }],
    });

    const identity = await describeIdentity(
      options(fetchImpl, FAT_TOKEN, { grantType: "client_credentials", clientId: "mcp" }),
    );

    expect(identity.rolesSource).toBe("token");
    expect(identity.realmManagementRoles).toEqual(["view-users"]);
  });

  it("admits it doesn't know rather than guessing, when neither source works", async () => {
    const fetchImpl = routed({
      "/users": new Response("{}", { status: 403 }),
      "/role-mappings": new Response("{}", { status: 403 }),
      "/admin/realms?": new Response("{}", { status: 403 }),
    });

    const identity = await describeIdentity(options(fetchImpl, LIGHTWEIGHT_TOKEN));

    expect(identity.rolesSource).toBe("unknown");
    expect(identity.hint).toMatch(/says nothing either way/);
  });

  it("warns when the account genuinely has no admin roles", async () => {
    const fetchImpl = routed({
      "/users?username=admin": [{ id: "u-nobody" }],
      "/users/u-nobody/role-mappings": { realmMappings: [{ name: "default-roles-master" }] },
      "/admin/realms?": [],
    });

    const identity = await describeIdentity(options(fetchImpl, LIGHTWEIGHT_TOKEN));

    expect(identity.rolesSource).toBe("role-mappings");
    expect(identity.hint).toMatch(/no admin roles/);
  });
});
