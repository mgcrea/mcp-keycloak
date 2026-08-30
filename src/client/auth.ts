import { KeycloakApiError } from "#/client/errors";
import type { GrantType } from "#/config";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/**
 * A pluggable source of admin access tokens. The admin client calls `getToken()`
 * on every request and `invalidate()` on a 401 to force the next call to refetch.
 */
export type TokenProvider = {
  getToken(): Promise<string>;
  invalidate(): void;
};

export type Credentials = {
  baseUrl: string;
  authRealm: string;
  clientId: string;
  clientSecret?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  grantType: GrantType;
};

export type TokenResponse = {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  refreshExpiresIn: number;
  scope: string;
};

export const tokenEndpoint = (baseUrl: string, authRealm: string): string =>
  `${baseUrl}/realms/${encodeURIComponent(authRealm)}/protocol/openid-connect/token`;

const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

/** Build the form body for the configured grant. */
const grantBody = (creds: Credentials): URLSearchParams => {
  const body = new URLSearchParams({
    grant_type: creds.grantType,
    client_id: creds.clientId,
  });
  if (creds.grantType === "client_credentials") {
    body.set("client_secret", creds.clientSecret ?? "");
  } else {
    body.set("username", creds.username ?? "");
    body.set("password", creds.password ?? "");
    // `admin-cli` is a PUBLIC client: sending a secret (even an empty one) gets
    // you a confusing `invalid_client`. Only send it if one is actually set,
    // which is the case for a confidential client using the password grant.
    if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  }
  return body;
};

const credentialHint = (grantType: GrantType): string =>
  grantType === "client_credentials"
    ? " — check KEYCLOAK_CLIENT_ID / KEYCLOAK_CLIENT_SECRET, that the client exists in " +
      "KEYCLOAK_AUTH_REALM, and that 'Client authentication' + 'Service accounts roles' are ON"
    : " — check KEYCLOAK_CLIENT_ID (usually `admin-cli`), KEYCLOAK_USERNAME / KEYCLOAK_PASSWORD, " +
      "and that the client has 'Direct access grants' enabled";

/** POST the token endpoint with an arbitrary form body and parse the response. */
const postToken = async (
  creds: Credentials,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> => {
  const url = tokenEndpoint(creds.baseUrl, creds.authRealm);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  const parsed = safeJsonParse(text);

  if (!res.ok) {
    const err = (parsed ?? {}) as { error?: unknown; error_description?: unknown };
    const detail = [err.error, err.error_description].filter(Boolean).join(": ");
    const hint = res.status === 401 || res.status === 400 ? credentialHint(creds.grantType) : "";
    throw new KeycloakApiError(
      `Keycloak token request failed: HTTP ${res.status} ${res.statusText}`.trim() +
        (detail ? ` (${detail})` : "") +
        hint,
      { status: res.status, errors: parsed ?? text },
    );
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (typeof obj.access_token !== "string" || typeof obj.expires_in !== "number") {
    throw new KeycloakApiError("Keycloak token response missing access_token / expires_in", {
      status: res.status,
      errors: parsed,
    });
  }

  return {
    accessToken: obj.access_token,
    expiresIn: obj.expires_in,
    ...(typeof obj.refresh_token === "string" ? { refreshToken: obj.refresh_token } : {}),
    refreshExpiresIn: typeof obj.refresh_expires_in === "number" ? obj.refresh_expires_in : 0,
    scope: typeof obj.scope === "string" ? obj.scope : "",
  };
};

/** Authenticate from scratch using the configured grant. */
export const requestToken = async (
  creds: Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> => postToken(creds, grantBody(creds), fetchImpl);

/** Exchange a refresh token for a fresh access token. */
export const refreshToken = async (
  creds: Credentials,
  refresh: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    refresh_token: refresh,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  return postToken(creds, body, fetchImpl);
};

export type TokenProviderOptions = {
  credentials: Credentials;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Refresh this many seconds before expiry. Clamped to half the token lifetime. */
  refreshSkewSeconds?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
};

/**
 * Caches an access token, refreshing it (a) just before it expires, using the
 * refresh token when one is available, and (b) on demand via `invalidate()`
 * after a 401. Concurrent refreshes share one in-flight request (single-flight).
 *
 * Keycloak access tokens are SHORT — 60s by default. A fixed skew larger than
 * the lifetime would refresh on every single request, so the effective skew is
 * clamped to half the token's own lifetime.
 */
export const createTokenProvider = (opts: TokenProviderOptions): TokenProvider => {
  const creds = opts.credentials;
  const fetchImpl = opts.fetch ?? fetch;
  const configuredSkewMs = (opts.refreshSkewSeconds ?? 30) * 1000;
  const now = opts.now ?? Date.now;

  let cached: { token: string; expiresAt: number } | undefined;
  let refresh: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const store = (result: TokenResponse): string => {
    const lifetimeMs = result.expiresIn * 1000;
    const skewMs = Math.min(configuredSkewMs, lifetimeMs / 2);
    cached = { token: result.accessToken, expiresAt: now() + lifetimeMs - skewMs };
    refresh =
      result.refreshToken && result.refreshExpiresIn > 0
        ? { token: result.refreshToken, expiresAt: now() + result.refreshExpiresIn * 1000 }
        : undefined;
    opts.logger?.debug?.(
      `[keycloak] token acquired; expires_in=${result.expiresIn}s refreshable=${Boolean(refresh)}`,
    );
    return result.accessToken;
  };

  const authenticate = async (): Promise<string> => {
    // Prefer the refresh token when we have a live one — cheaper, and it keeps
    // the SSO session alive. `client_credentials` typically returns none
    // (refresh_expires_in: 0), so this is opportunistic, never required.
    if (refresh && now() < refresh.expiresAt) {
      try {
        return store(await refreshToken(creds, refresh.token, fetchImpl));
      } catch (err) {
        // An idled-out session comes back as `invalid_grant`. Fall through to a
        // full re-auth rather than surfacing it.
        opts.logger?.debug?.(`[keycloak] refresh failed, re-authenticating: ${String(err)}`);
        refresh = undefined;
      }
    }
    opts.logger?.debug?.(`[keycloak] authenticating via ${creds.grantType}`);
    return store(await requestToken(creds, fetchImpl));
  };

  return {
    async getToken(): Promise<string> {
      if (cached && now() < cached.expiresAt) {
        return cached.token;
      }
      if (!inflight) {
        inflight = authenticate().finally(() => {
          inflight = undefined;
        });
      }
      return inflight;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
};

/** Trivial token provider that always returns a fixed string. Useful in tests. */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => {},
});
