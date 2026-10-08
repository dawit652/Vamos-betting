/** Base class of catalogue write errors (the API maps them to 404 / 409). */
export class CatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CatalogError';
  }
}

/** The event, market or selection does not exist. */
export class CatalogNotFoundError extends CatalogError {
  constructor(
    readonly entity: 'event' | 'market' | 'selection',
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = 'CatalogNotFoundError';
  }
}

/** The change is not allowed in the row's current state (e.g. odds of a settled market). */
export class CatalogStateError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogStateError';
  }
}

/** SQLSTATE and constraint name of the Postgres error along a driver/ORM cause chain. */
export function postgresErrorOf(error: unknown): { code: string; constraint?: string } | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return typeof constraint === 'string' ? { code, constraint } : { code };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** True for a unique violation (23505), optionally of the named constraint only. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = postgresErrorOf(error);
  if (pg === null || pg.code !== '23505') return false;
  return constraint === undefined || pg.constraint === constraint;
}
