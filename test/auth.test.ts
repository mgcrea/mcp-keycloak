import { describe, expect, it, vi } from "vitest";

import { createTokenProvider, requestToken, tokenEndpoint, type Credentials } from "#/client/auth";
import { KeycloakApiError } from "#/client/errors";

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const tokenBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: "at-1",
  expires_in: 60,
  refresh_token: "rt-1",
  refresh_expires_in: 1800,
  scope: "profile email",
  ...overrides,
});

const serviceAccount: Credentials = {
  baseUrl: "https://keycloak.rgis.dev",
  authRealm: "master",
  clientId: "mcp",
  clientSecret: "s3cret",
  grantType: "client_credentials",
};

const adminUser: Credentials = {
  baseUrl: "https://keycloak.rgis.dev",
  authRealm: "master",
  clientId: "admin-cli",
  username: "admin",
  password: "pw",
  grantType: "password",
};

const lastCall = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] =>
  fetchImpl.mock.calls.at(-1) as [string, RequestInit];

describe("tokenEndpoint", () => {
  it("builds the OIDC token url for the auth realm", () => {
    expect(tokenEndpoint("https://keycloak.rgis.dev", "master")).toBe(
      "https://keycloak.rgis.dev/realms/master/protocol/openid-connect/token",
    );
  });
});

describe("requestToken", () => {
  it("posts a form-encoded client_credentials grant", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenBody()));
    const result = await requestToken(serviceAccount, fetchImpl as unknown as typeof fetch);

    expect(result.accessToken).toBe("at-1");
    expect(result.expiresIn).toBe(60);
    expect(result.refreshToken).toBe("rt-1");

    const [url, init] = lastCall(fetchImpl);
    expect(url).toBe("https://keycloak.rgis.dev/realms/master/protocol/openid-connect/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("mcp");
    expect(body.get("client_secret")).toBe("s3cret");
  });

  it("posts a password grant WITHOUT a client_secret for a public client", async () => {
    // `admin-cli` is public: sending any client_secret gets an `invalid_client`.
    const fetchImpl = vi.fn(async () => jsonResponse(tokenBody()));
    await requestToken(adminUser, fetchImpl as unknown as typeof fetch);

    const body = new URLSearchParams(lastCall(fetchImpl)[1].body as string);
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("client_id")).toBe("admin-cli");
    expect(body.get("username")).toBe("admin");
    expect(body.get("password")).toBe("pw");
    expect(body.has("client_secret")).toBe(false);
  });

  it("sends the secret on a password grant against a confidential client", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenBody()));
    await requestToken(
      { ...adminUser, clientSecret: "conf" },
      fetchImpl as unknown as typeof fetch,
    );
    const body = new URLSearchParams(lastCall(fetchImpl)[1].body as string);
    expect(body.get("client_secret")).toBe("conf");
  });

  it("surfaces a credentials hint on a 401", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
    );
    await expect(
      requestToken(serviceAccount, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({
      name: "KeycloakApiError",
      status: 401,
      message: expect.stringContaining("KEYCLOAK_CLIENT_SECRET"),
    });
  });

  it("throws when the response has no access_token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ scope: "profile" }));
    await expect(
      requestToken(serviceAccount, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(KeycloakApiError);
  });
});

describe("createTokenProvider", () => {
  it("caches the token across calls", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenBody({ expires_in: 300 })));
    let now = 1_000_000;
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("at-1");
    now += 60_000;
    expect(await provider.getToken()).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("clamps the refresh skew to half the token lifetime", async () => {
    // Keycloak's default access token lives 60s. With the configured 120s skew
    // applied literally, the token would be considered stale the instant it was
    // issued and every request would re-authenticate.
    const fetchImpl = vi.fn(async () => jsonResponse(tokenBody({ expires_in: 60 })));
    let now = 1_000_000;
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
      refreshSkewSeconds: 120,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("at-1");
    // Skew clamps to 30s, so the token stays good until 30s in.
    now += 29_000;
    expect(await provider.getToken()).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past the clamped skew it refreshes.
    now += 2_000;
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the refresh token when one is available", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "at-1" })))
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "at-2" })));
    let now = 1_000_000;
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("at-1");
    now += 60_000; // past expiry
    expect(await provider.getToken()).toBe("at-2");

    const body = new URLSearchParams(lastCall(fetchImpl)[1].body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
  });

  it("re-authenticates from scratch when the refresh token is rejected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "at-1" })))
      // An idled-out SSO session comes back as invalid_grant.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      )
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "at-3" })));
    let now = 1_000_000;
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("at-1");
    now += 60_000;
    expect(await provider.getToken()).toBe("at-3");

    const body = new URLSearchParams(lastCall(fetchImpl)[1].body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("does not try to refresh when refresh_expires_in is 0", async () => {
    // Typical of client_credentials: a refresh_token may be present but is dead.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(tokenBody({ refresh_expires_in: 0, expires_in: 60 })),
    );
    let now = 1_000_000;
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    await provider.getToken();
    now += 60_000;
    await provider.getToken();

    const body = new URLSearchParams(lastCall(fetchImpl)[1].body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("refetches after invalidate()", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "at-1" })))
      .mockResolvedValueOnce(jsonResponse(tokenBody({ access_token: "at-2" })));
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(await provider.getToken()).toBe("at-1");
    provider.invalidate();
    expect(await provider.getToken()).toBe("at-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent refreshes (single-flight)", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const provider = createTokenProvider({
      credentials: serviceAccount,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const a = provider.getToken();
    const b = provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch?.(jsonResponse(tokenBody({ access_token: "at-solo" })));
    expect(await a).toBe("at-solo");
    expect(await b).toBe("at-solo");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
