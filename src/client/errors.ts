export class KeycloakApiError extends Error {
  override readonly name = "KeycloakApiError";
  readonly status: number;
  readonly errors: unknown;

  constructor(message: string, opts: { status: number; errors?: unknown }) {
    super(message);
    this.status = opts.status;
    this.errors = opts.errors;
  }
}

/** Thrown when a write tool is reached while KEYCLOAK_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set KEYCLOAK_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}
