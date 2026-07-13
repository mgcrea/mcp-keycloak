import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { assertSafePath } from "../src/tools/request.js";

const baseConfig: Config = {
  baseUrl: "https://keycloak.rgis.dev",
  realm: "master",
  authRealm: "master",
  clientId: "mcp",
  clientSecret: "s3cret",
  grantType: "client_credentials",
  allowWrites: false,
  maxRetries: 3,
  refreshSkewSeconds: 30,
};

/** Spin up the server over an in-memory transport and return a connected client. */
const connect = async (
  config: Config,
  fetchImpl: typeof fetch = vi.fn(async () => new Response("[]")) as unknown as typeof fetch,
): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("at-1"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).sort();

/** The `method` enum a tool advertises, which is how the write gate shows up in the schema. */
const methodEnum = async (client: Client, name: string): Promise<string[] | undefined> => {
  const tool = (await client.listTools()).tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
  return properties.method?.enum;
};

/** vi.fn() infers a zero-arg call signature, so recover the real fetch args. */
const callArgs = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] =>
  fetchImpl.mock.calls[index] as unknown as [string, RequestInit];

describe("tool registration", () => {
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    readOnly = await toolNames(await connect(baseConfig));
    withWrites = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
  });

  it("registers the read tools in both modes", () => {
    for (const name of [
      "keycloak_whoami",
      "keycloak_list_realms",
      "keycloak_list_users",
      "keycloak_list_clients",
      "keycloak_list_groups",
      "keycloak_list_realm_roles",
      "keycloak_list_events",
      "keycloak_list_client_scopes",
      "keycloak_list_identity_providers",
      "keycloak_list_authentication_flows",
      "keycloak_request",
    ]) {
      expect(readOnly, name).toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("hides every write tool when writes are disabled", () => {
    // Not merely refused — absent, so an agent cannot call them at all.
    const writeTools = withWrites.filter((name) => !readOnly.includes(name));
    expect(writeTools.length).toBeGreaterThan(20);
    for (const name of [
      "keycloak_create_user",
      "keycloak_delete_user",
      "keycloak_reset_user_password",
      "keycloak_delete_realm",
      "keycloak_logout_all_sessions",
      "keycloak_regenerate_client_secret",
    ]) {
      expect(readOnly, name).not.toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("marks read tools readOnly and destructive ones destructive", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get("keycloak_list_users")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("keycloak_delete_user")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("keycloak_delete_realm")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("keycloak_create_user")?.annotations?.destructiveHint).toBe(false);
  });
});

describe("keycloak_request", () => {
  it("only offers GET when writes are disabled", async () => {
    const client = await connect(baseConfig);
    expect(await methodEnum(client, "keycloak_request")).toEqual(["GET"]);

    const tool = (await client.listTools()).tools.find((t) => t.name === "keycloak_request");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("offers the write methods when writes are enabled", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    expect(await methodEnum(client, "keycloak_request")).toEqual(["GET", "POST", "PUT", "DELETE"]);
  });

  it("resolves a realm-relative path under the realm", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({ name: "keycloak_request", arguments: { path: "components" } });

    expect(callArgs(fetchImpl)[0]).toBe("https://keycloak.rgis.dev/admin/realms/master/components");
  });

  it("passes an absolute /admin path straight through", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({ name: "keycloak_request", arguments: { path: "/admin/serverinfo" } });

    expect(callArgs(fetchImpl)[0]).toBe("https://keycloak.rgis.dev/admin/serverinfo");
  });
});

describe("assertSafePath", () => {
  it("rejects an absolute URL, so the token can't be sent to another host", () => {
    expect(() => assertSafePath("https://evil.example.com/steal")).toThrow(/absolute URL/);
  });

  it("rejects traversal", () => {
    expect(() => assertSafePath("users/../../..")).toThrow(/\.\./);
  });

  it("rejects the public OIDC surface", () => {
    expect(() => assertSafePath("/realms/master/protocol/openid-connect/token")).toThrow(
      /public OIDC surface/,
    );
  });

  it("allows normal admin paths", () => {
    expect(() => assertSafePath("users/abc-123/credentials")).not.toThrow();
    expect(() => assertSafePath("/admin/serverinfo")).not.toThrow();
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "keycloak_delete_user",
      arguments: { userId: "u1" },
    });

    expect(result.isError).toBe(true);
    // Crucially: it never reached Keycloak.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("run when confirmed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "keycloak_delete_user",
      arguments: { userId: "u1", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe("https://keycloak.rgis.dev/admin/realms/master/users/u1");
    expect(init.method).toBe("DELETE");
  });
});

describe("event tools", () => {
  it("explain that logging is off rather than returning a bare empty list", async () => {
    const fetchImpl = vi
      .fn()
      // GET /events -> []
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      // GET /events/config -> disabled
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ eventsEnabled: false, adminEventsEnabled: false }), {
          status: 200,
        }),
      );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({ name: "keycloak_list_events", arguments: {} });
    const text = (result.content as { text: string }[])[0]?.text ?? "";

    expect(text).toContain("DISABLED");
    expect(text).toContain("keycloak_update_realm");
  });

  it("stay quiet when events are enabled and there simply are none", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ eventsEnabled: true }), { status: 200 }),
      );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({ name: "keycloak_list_events", arguments: {} });
    const text = (result.content as { text: string }[])[0]?.text ?? "";

    expect(text).not.toContain("DISABLED");
  });
});
