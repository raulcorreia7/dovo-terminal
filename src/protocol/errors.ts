/**
 * Every failure that crosses a RuntimeClient boundary is a DovoError.
 * `cause` carries the underlying problem (fetch rejection, upstream status
 * via `UpstreamError`, zod issue) so callers can report without re-parsing.
 */
export class DovoError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DovoError";
    this.cause = cause;
  }
}

/** An upstream answered with a non-2xx status; the local server maps it onward. */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}
