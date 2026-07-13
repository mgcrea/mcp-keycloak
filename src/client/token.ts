// Decoding of the access token's payload, for the `keycloak_whoami` diagnostic
// only. The signature is NOT verified — we are the party that just fetched this
// token from Keycloak over TLS, and we make no authorization decisions with it.

export type AccessTokenClaims = {
  iss?: string;
  azp?: string;
  sub?: string;
  exp?: number;
  preferred_username?: string;
  scope?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
  [key: string]: unknown;
};

/** Decode the payload of a JWT without verifying its signature. */
export const decodeJwtPayload = (jwt: string): AccessTokenClaims => {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new Error("Not a JWT: expected three dot-separated segments");
  }
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(json) as AccessTokenClaims;
};

/** The realm a token was issued by, parsed out of its `iss` claim. */
export const realmFromIssuer = (iss: string | undefined): string | undefined =>
  iss?.match(/\/realms\/([^/]+)\/?$/)?.[1];
