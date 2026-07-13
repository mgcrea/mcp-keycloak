import type { GrantType } from "../config.js";
import type { KeycloakAdminClient } from "./admin.js";
import type { TokenProvider } from "./auth.js";
import { decodeJwtPayload, realmFromIssuer } from "./token.js";

// Working out what the server is allowed to do is NOT a matter of reading the
// access token. Keycloak issues "lightweight" tokens to some clients — `admin-cli`
// among them — carrying no `sub`, no username and no role claims at all, while the
// account behind them may well be a full realm admin: admin rights are evaluated
// server-side from the user's role mappings, not from claims in the token.
//
// So trusting the token would report "no roles, expect 403s" at a master-realm
// admin, which is worse than saying nothing. Instead: resolve the acting user,
// then ask Keycloak for their actual role mappings.

/** Realm roles that confer blanket admin rights. */
const ADMIN_REALM_ROLES = ["admin", "realm-admin"];

type RoleRep = { name?: string };

type RoleMappings = {
  realmMappings?: RoleRep[];
  clientMappings?: Record<string, { mappings?: RoleRep[] }>;
};

export type Identity = {
  issuer: string | undefined;
  authRealm: string | undefined;
  defaultRealm: string;
  clientId: string | undefined;
  grantType: GrantType;
  preferredUsername: string | undefined;
  subject: string | undefined;
  expiresInSeconds: number | undefined;
  realmRoles: string[] | undefined;
  realmManagementRoles: string[] | undefined;
  /** Where the roles above came from — a token with no role claims proves nothing. */
  rolesSource: "role-mappings" | "token" | "unknown";
  writesEnabled: boolean;
  accessibleRealms: string[] | undefined;
  hint?: string;
};

export type DescribeIdentityOptions = {
  client: KeycloakAdminClient;
  tokenProvider: TokenProvider;
  authRealm: string;
  grantType: GrantType;
  clientId: string;
  username?: string | undefined;
  allowWrites: boolean;
};

const names = (roles: RoleRep[] | undefined): string[] =>
  (roles ?? []).flatMap((r) => (r.name ? [r.name] : []));

/**
 * Find the user the current token acts as. The token usually can't tell us
 * (see above), so fall back to looking them up: by username for the password
 * grant, or via the client's service-account user for client_credentials.
 */
const resolveSubject = async (opts: DescribeIdentityOptions): Promise<string | undefined> => {
  const { client, authRealm, grantType, clientId, username } = opts;

  if (grantType === "password" && username) {
    const users = await client
      .get<{ id?: string }[]>(client.realmPath(authRealm, "/users"), {
        username,
        exact: true,
        briefRepresentation: true,
      })
      .catch(() => undefined);
    return users?.[0]?.id;
  }

  const clients = await client
    .get<{ id?: string }[]>(client.realmPath(authRealm, "/clients"), { clientId })
    .catch(() => undefined);
  const uuid = clients?.[0]?.id;
  if (!uuid) return undefined;

  const serviceAccount = await client
    .get<{ id?: string }>(client.realmPath(authRealm, `/clients/${uuid}/service-account-user`))
    .catch(() => undefined);
  return serviceAccount?.id;
};

export const describeIdentity = async (opts: DescribeIdentityOptions): Promise<Identity> => {
  const { client, tokenProvider, authRealm, grantType, allowWrites } = opts;
  const claims = decodeJwtPayload(await tokenProvider.getToken());

  const subject = claims.sub ?? (await resolveSubject(opts));

  const mappings = subject
    ? await client
        .get<RoleMappings>(client.realmPath(authRealm, `/users/${subject}/role-mappings`))
        .catch(() => undefined)
    : undefined;

  const tokenRealmRoles = claims.realm_access?.roles;
  const tokenManagementRoles = claims.resource_access?.["realm-management"]?.roles;

  const realmRoles = mappings ? names(mappings.realmMappings) : tokenRealmRoles;
  const realmManagementRoles = mappings
    ? names(mappings.clientMappings?.["realm-management"]?.mappings)
    : tokenManagementRoles;

  const rolesSource: Identity["rolesSource"] = mappings
    ? "role-mappings"
    : tokenRealmRoles || tokenManagementRoles
      ? "token"
      : "unknown";

  const accessibleRealms = await client
    .get<{ realm?: string }[]>("/admin/realms", { briefRepresentation: true })
    .then((realms) => realms.flatMap((r) => (r.realm ? [r.realm] : [])))
    .catch(() => undefined);

  const identity: Identity = {
    issuer: claims.iss,
    authRealm: realmFromIssuer(claims.iss) ?? authRealm,
    defaultRealm: client.defaultRealm,
    clientId: claims.azp,
    grantType,
    preferredUsername: claims.preferred_username ?? opts.username,
    subject,
    expiresInSeconds: claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : undefined,
    realmRoles,
    realmManagementRoles,
    rolesSource,
    writesEnabled: allowWrites,
    accessibleRealms,
  };

  const hasAdminRole = (realmRoles ?? []).some((role) => ADMIN_REALM_ROLES.includes(role));
  const hasManagementRole = (realmManagementRoles ?? []).length > 0;
  const canSeeRealms = (accessibleRealms ?? []).length > 0;

  if (rolesSource === "unknown") {
    identity.hint =
      "Could not determine this account's roles: the token carries no role claims (Keycloak " +
      "issues lightweight tokens to some clients) and its role mappings could not be read. " +
      "This says nothing either way about what it can do — judge by whether calls actually succeed.";
  } else if (!hasAdminRole && !hasManagementRole && !canSeeRealms) {
    identity.hint =
      "This account holds no admin roles, so most calls will 403. Grant it either the " +
      "'realm-admin' composite from the 'realm-management' client (Clients -> realm-management " +
      "-> Roles, assigned via the account's Role mapping tab, or for a service account via " +
      "Clients -> <client> -> Service account roles), or the 'admin' realm role in `master` to " +
      "administer every realm.";
  }

  return identity;
};
