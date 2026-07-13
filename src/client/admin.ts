import type { Logger, TokenProvider } from "./auth.js";
import { KeycloakApiError } from "./errors.js";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
};

export type AdminClientOptions = {
  baseUrl: string;
  tokenProvider: TokenProvider;
  defaultRealm: string;
  maxRetries?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

/** A created resource, as reported by Keycloak's `Location` header. */
export type Created = {
  id: string | undefined;
  location: string | undefined;
  created: true;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Keycloak answers a successful POST with `201 Created`, an EMPTY body, and the
 * new resource's id buried in the `Location` header. Without this the caller has
 * no way to learn what it just created.
 */
export const parseLocationId = (res: Response): Created => {
  const location = res.headers.get("Location") ?? undefined;
  const id = location?.split("/").filter(Boolean).pop();
  return { id, location, created: true };
};

const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // Keycloak takes repeated keys for multi-valued filters (e.g. ?type=LOGIN&type=LOGOUT).
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

/**
 * Minimal fetch-based client for the Keycloak Admin REST API.
 *
 * Paths are absolute admin paths (`/admin/realms`, `/admin/serverinfo`); use
 * `realmPath()` to build the realm-scoped ones. Retries on a 401 (refetching the
 * token first) and on 429/5xx with exponential backoff.
 */
export class KeycloakAdminClient {
  readonly defaultRealm: string;
  private readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;

  constructor(opts: AdminClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokenProvider = opts.tokenProvider;
    this.defaultRealm = opts.defaultRealm;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-keycloak-js";
  }

  /** Build a realm-scoped admin path: realmPath("dev", "/users") -> "/admin/realms/dev/users". */
  realmPath(realm: string | undefined, suffix = ""): string {
    const target = realm ?? this.defaultRealm;
    return `/admin/realms/${encodeURIComponent(target)}${suffix}`;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    // `body` may legitimately be present on DELETE — Keycloak's role-mapping
    // removal endpoints take a JSON array body.
    const hasBody = opts.body !== undefined;
    let attempt = 0;

    for (;;) {
      this.logger?.debug?.(`[keycloak] ${method} ${url} (attempt ${attempt + 1})`);
      const token = await this.tokenProvider.getToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      });

      // Token rejected mid-session — drop it and retry with a fresh one.
      if (res.status === 401 && attempt < this.maxRetries) {
        this.logger?.warn?.(`[keycloak] HTTP 401 — invalidating token and retrying`);
        this.tokenProvider.invalidate();
        attempt += 1;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`[keycloak] HTTP ${res.status} — retrying in ${delay}ms`);
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        throw new KeycloakApiError(this.errorMessage(res, method, path), {
          status: res.status,
          errors: safeJsonParse(await res.text()),
        });
      }

      // A create returns 201 + empty body; the id is only in the Location header.
      if (res.status === 201) {
        return parseLocationId(res) as T;
      }

      const text = await res.text();
      // 204 No Content, and most PUT/DELETE responses, have an empty body.
      if (res.status === 204 || text.trim() === "") {
        return null as T;
      }
      // Note: some endpoints return a bare scalar (GET /users/count -> `12`),
      // so this deliberately does not assume an object.
      return safeJsonParse(text) as T;
    }
  }

  private errorMessage(res: Response, method: string, path: string): string {
    const base =
      `Keycloak API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim();
    if (res.status === 403) {
      return (
        `${base} — the token authenticated but lacks the required permission. Keycloak admin ` +
        `rights come from the 'realm-management' client roles (view-users, manage-users, ` +
        `view-clients, manage-clients, view-realm, manage-realm, view-events, ...; ` +
        `'realm-admin' is the composite granting all of them). Call keycloak_whoami to see ` +
        `which roles the current token actually carries.`
      );
    }
    if (res.status === 404) {
      return `${base} — check the realm name and that the id is the one Keycloak expects (clients and groups are addressed by UUID, not by their human-facing clientId/name).`;
    }
    return base;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  put<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }

  del<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { body, query });
  }
}
