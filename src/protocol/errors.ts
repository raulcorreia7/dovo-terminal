/**
 * Every failure that crosses a RuntimeClient boundary is a DovoError.
 * `cause` carries the underlying problem (fetch rejection, upstream status
 * via `UpstreamError`, zod issue) so callers can report without re-parsing.
 */
export class DovoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DovoError";
  }
}

/** Control-flow guard for exhaustive switches; TS proves it unreachable. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

/** Everything a catch clause can render, safely and with one function. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
