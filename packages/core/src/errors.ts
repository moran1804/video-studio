/** Errors that carry a message which is safe to show in the UI. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'bad_request',
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export class NotFoundError extends UserFacingError {
  constructor(what = 'Resource') {
    super(`${what} not found`, 404, 'not_found');
  }
}

/** Provider / network errors. `retryable` drives queue retry behaviour. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly options: {
      provider: string;
      retryable: boolean;
      status?: number;
      retryAfterMs?: number;
      code?: string;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.options.retryable;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof UserFacingError) return false;
  return true;
}
