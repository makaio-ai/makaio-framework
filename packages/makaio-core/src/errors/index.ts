/**
 * Base error class for all Makaio-related errors.
 */
export class MakaioError extends Error {
  public constructor(
    message: string,
    public readonly subject?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class InvalidModelError extends MakaioError {
  public constructor(
    requestedModel: string,
    public readonly subject?: string,
  ) {
    super(`Invalid model specified: ${requestedModel}`);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class DirectoryNotFoundError extends MakaioError {
  public constructor(
    path: string,
    public readonly subject?: string,
  ) {
    super(`Directory does not exist: ${path}`);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ConfigError extends MakaioError {
  public constructor(
    message: string,
    public readonly subject?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// ============================================================================
// Adapter Error Categories
// ============================================================================

/**
 * Error categories for adapter failures.
 * Used by VirtualModel fallback configuration to determine retry eligibility.
 */
export type ErrorCategory = 'rate_limit' | 'auth' | 'model_unavailable' | 'quota_exceeded' | 'all';

/** Thrown when a provider rate-limits the request. */
export class RateLimitError extends MakaioError {
  public readonly code = 'rate_limit' as const;
}

/** Thrown when authentication/authorization fails. */
export class AuthenticationError extends MakaioError {
  public readonly code = 'auth' as const;
}

/** Thrown when the requested model is unavailable (deprecated, not found, etc.). */
export class ModelUnavailableError extends MakaioError {
  public readonly code = 'model_unavailable' as const;
}

/** Thrown when a usage quota (tokens, requests) is exceeded. */
export class QuotaExceededError extends MakaioError {
  public readonly code = 'quota_exceeded' as const;
}
