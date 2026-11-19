const HTTP_ERROR = Symbol.for("tansy.HttpError");

/** A deliberate, client-safe failure. Anything else becomes a generic 500. */
export class HttpError extends Error {
  /**
   * In development Next can load this module more than once: plugins come from the config
   * instrumentation.ts provides, routes from their own module graph. A brand, not the class,
   * says what an HttpError is, so one a plugin throws is still answered with its status.
   * Subclasses are checked by their prototype as usual.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== HttpError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === "object" && value !== null && (value as { [HTTP_ERROR]?: unknown })[HTTP_ERROR] === true;
  }

  readonly [HTTP_ERROR] = true;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, "UNAUTHENTICATED", "Authentication required.");
export const forbidden = () => new HttpError(403, "FORBIDDEN", "You do not have access to this resource.");
export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found.`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details);
