// Keycloak representations are large: a UserRepresentation carries ~20 fields
// even with `briefRepresentation=true`, a ClientRepresentation carries ~40, and
// GET /admin/serverinfo is roughly a megabyte of SPI metadata. Listing a few
// hundred users raw would swamp the context window, so list tools summarize.
// `get_*` tools return the full representation — that's the point of a get.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Apply a summarizer across an array, passing non-arrays through untouched. */
export const summarizeEach = <T>(value: unknown, fn: (item: Rec) => T): unknown =>
  Array.isArray(value) ? value.filter(isRecord).map(fn) : value;

export const summarizeUser = (user: Rec): Rec => ({
  id: user.id,
  username: user.username,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  enabled: user.enabled,
  emailVerified: user.emailVerified,
  createdTimestamp: user.createdTimestamp,
});

export const summarizeClient = (client: Rec): Rec => ({
  // Both ids, deliberately: every /clients/{id}/... path takes the UUID, while
  // humans and the admin console only ever show the clientId string.
  id: client.id,
  clientId: client.clientId,
  name: client.name,
  description: client.description,
  enabled: client.enabled,
  publicClient: client.publicClient,
  serviceAccountsEnabled: client.serviceAccountsEnabled,
  standardFlowEnabled: client.standardFlowEnabled,
  protocol: client.protocol,
});

export const summarizeGroup = (group: Rec): Rec => ({
  id: group.id,
  name: group.name,
  path: group.path,
  ...(Array.isArray(group.subGroups) && group.subGroups.length > 0
    ? { subGroups: group.subGroups.filter(isRecord).map(summarizeGroup) }
    : {}),
});

export const summarizeSession = (session: Rec): Rec => ({
  id: session.id,
  username: session.username,
  userId: session.userId,
  ipAddress: session.ipAddress,
  start: session.start,
  lastAccess: session.lastAccess,
  clients: session.clients,
});

export const summarizeEvent = (event: Rec): Rec => ({
  time: event.time,
  type: event.type,
  realmId: event.realmId,
  clientId: event.clientId,
  userId: event.userId,
  ipAddress: event.ipAddress,
  error: event.error,
  details: event.details,
});

export const summarizeAdminEvent = (event: Rec): Rec => ({
  time: event.time,
  realmId: event.realmId,
  operationType: event.operationType,
  resourceType: event.resourceType,
  resourcePath: event.resourcePath,
  error: event.error,
  authDetails: isRecord(event.authDetails)
    ? {
        realmId: event.authDetails.realmId,
        clientId: event.authDetails.clientId,
        userId: event.authDetails.userId,
        ipAddress: event.authDetails.ipAddress,
      }
    : undefined,
});

/** GET /admin/serverinfo is ~1MB of SPI/theme/mapper metadata. Keep the useful head. */
export const summarizeServerInfo = (info: Rec): Rec => ({
  systemInfo: info.systemInfo,
  memoryInfo: info.memoryInfo,
  profileInfo: info.profileInfo,
  features: info.features,
});

const SECRET_KEYS = ["clientSecret", "secret", "privateKey", "password"];

/**
 * Mask credential-shaped values inside an identity provider's `config` block —
 * these representations carry the live IdP client secret in plain text.
 */
export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEYS.includes(key) && typeof val === "string" && val !== "") {
      out[key] = "**********";
    } else {
      out[key] = redactSecrets(val);
    }
  }
  return out;
};
