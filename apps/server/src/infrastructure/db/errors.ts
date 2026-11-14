import { DrizzleQueryError } from 'drizzle-orm';

/**
 * A failed query without its parameters. Drizzle's own error repeats every parameter in its
 * message, stack and fields, and those hold raw provider payloads with the payer's CLABE and
 * phone hashes.
 */
export class DatabaseQueryError extends Error {
  override readonly name = 'DatabaseQueryError';
  /** Postgres SQLSTATE. */
  readonly code: string | undefined;

  constructor(query: string, cause: unknown) {
    super(`Failed query: ${query}`, { cause });
    this.code = sqlState(cause);
  }
}

export const SqlState = { ExclusionViolation: '23P01' } as const;

export function withoutQueryParameters(error: unknown): unknown {
  return error instanceof DrizzleQueryError ? new DatabaseQueryError(error.query, error.cause) : error;
}

/** Runs database work so that a failure never carries query parameters into logs. */
export async function sanitized<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw withoutQueryParameters(error);
  }
}

/** True when `error` is a Postgres violation of the named constraint, wrapped or not. */
export function violates(error: unknown, code: string, constraint: string): boolean {
  const driverError = error instanceof DrizzleQueryError || error instanceof DatabaseQueryError ? error.cause : error;
  return sqlState(driverError) === code && field(driverError, 'constraint_name') === constraint;
}

function sqlState(cause: unknown): string | undefined {
  return field(cause, 'code');
}

function field(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(name in value)) return undefined;
  const found: unknown = (value as Record<string, unknown>)[name];
  return typeof found === 'string' ? found : undefined;
}
