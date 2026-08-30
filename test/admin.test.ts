import { describe, expect, it, vi } from "vitest";

import { KeycloakAdminClient, parseLocationId } from "#/client/admin";
import type { TokenProvider } from "#/client/auth";
import { KeycloakApiError } from "#/client/errors";

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const trackingTokenProvider = (): TokenProvider & { invalidated: number } => {
  const provider = {
    invalidated: 0,
    getToken: async () => "at-1",
    invalidate: () => {
      provider.invalidated += 1;
    },
  };
  return provider;
};

const makeClient = (
  fetchImpl: ReturnType<typeof vi.fn>,
  tokenProvider: TokenProvider = trackingTokenProvider(),
  maxRetries = 3,
): KeycloakAdminClient =>
  new KeycloakAdminClient({
    baseUrl: "https://keycloak.rgis.dev",
    tokenProvider,
    defaultRealm: "master",
    maxRetries,
    fetch: fetchImpl as unknown as typeof fetch,
  });

const lastCall = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] =>
  fetchImpl.mock.calls.at(-1) as [string, RequestInit];

describe("realmPath", () => {
  it("builds realm-scoped admin paths, defaulting to the configured realm", () => {
    const client = makeClient(vi.fn());
    expect(client.realmPath(undefined, "/users")).toBe("/admin/realms/master/users");
    expect(client.realmPath("dev", "/users")).toBe("/admin/realms/dev/users");
    expect(client.realmPath("dev")).toBe("/admin/realms/dev");
  });
});

describe("parseLocationId", () => {
  it("extracts the created id from the Location header", () => {
    // Keycloak answers a create with 201, an EMPTY body, and the id only here.
    const res = new Response(null, {
      status: 201,
      headers: { Location: "https://keycloak.rgis.dev/admin/realms/master/users/abc-123" },
    });
    expect(parseLocationId(res)).toEqual({
      id: "abc-123",
      location: "https://keycloak.rgis.dev/admin/realms/master/users/abc-123",
      created: true,
    });
  });

  it("copes with no Location header", () => {
    expect(parseLocationId(new Response(null, { status: 201 }))).toEqual({
      id: undefined,
      location: undefined,
      created: true,
    });
  });
});

describe("KeycloakAdminClient.request", () => {
  it("sends a bearer token and serializes the query string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: "u1" }]));
    const client = makeClient(fetchImpl);

    await client.get("/admin/realms/master/users", { search: "bob", max: 10, exact: true });

    const [url, init] = lastCall(fetchImpl);
    expect(url).toBe(
      "https://keycloak.rgis.dev/admin/realms/master/users?search=bob&max=10&exact=true",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
  });

  it("drops undefined query params and repeats array ones", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = makeClient(fetchImpl);

    await client.get("/admin/realms/master/events", {
      type: ["LOGIN", "LOGIN_ERROR"],
      client: undefined,
    });

    expect(lastCall(fetchImpl)[0]).toBe(
      "https://keycloak.rgis.dev/admin/realms/master/events?type=LOGIN&type=LOGIN_ERROR",
    );
  });

  it("returns the created id on a 201", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 201,
          headers: { Location: "https://keycloak.rgis.dev/admin/realms/master/users/new-id" },
        }),
    );
    const client = makeClient(fetchImpl);

    await expect(client.post("/admin/realms/master/users", { username: "bob" })).resolves.toEqual({
      id: "new-id",
      location: "https://keycloak.rgis.dev/admin/realms/master/users/new-id",
      created: true,
    });
  });

  it("returns null for a 204 and for an empty body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const client = makeClient(fetchImpl);

    await expect(client.del("/admin/realms/master/users/u1")).resolves.toBeNull();
    await expect(client.put("/admin/realms/master/users/u1", {})).resolves.toBeNull();
  });

  it("parses a bare scalar body (GET /users/count returns just a number)", async () => {
    const fetchImpl = vi.fn(async () => new Response("12", { status: 200 }));
    const client = makeClient(fetchImpl);
    await expect(client.get("/admin/realms/master/users/count")).resolves.toBe(12);
  });

  it("sends a body on DELETE (role-mapping removal needs one)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchImpl);

    await client.del("/admin/realms/master/users/u1/role-mappings/realm", [
      { id: "r1", name: "admin" },
    ]);

    const [, init] = lastCall(fetchImpl);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify([{ id: "r1", name: "admin" }]));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("invalidates the token and retries once on a 401", async () => {
    const tokenProvider = trackingTokenProvider();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ realm: "master" }));
    const client = makeClient(fetchImpl, tokenProvider);

    await expect(client.get("/admin/realms/master")).resolves.toEqual({ realm: "master" });
    expect(tokenProvider.invalidated).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up on a 401 once the retry budget is spent", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const client = makeClient(fetchImpl, trackingTokenProvider(), 1);

    await expect(client.get("/admin/realms/master")).rejects.toBeInstanceOf(KeycloakApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("explains a 403 in terms of realm-management roles", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );
    const client = makeClient(fetchImpl);

    await expect(client.get("/admin/realms/master/users")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("realm-management"),
    });
  });

  it("retries a 429 and honors Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "1" } }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = makeClient(fetchImpl);

      const promise = client.get("/admin/realms/master/users");
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
