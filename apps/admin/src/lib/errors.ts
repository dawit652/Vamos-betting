/** A failed API call: `status` 0 means no answer, `code` is the API's machine-readable code. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The error for a non-2xx response from its parsed body (`{ error: { code, message, details? } }`). */
export function errorFromBody(status: number, body: unknown): ApiClientError {
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error !== null && typeof error === 'object') {
      const { code, message, details } = error as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
      };
      if (typeof code === 'string' && typeof message === 'string') {
        return new ApiClientError(status, code, message, details);
      }
    }
  }
  return new ApiClientError(status, `http_${status}`, `Request failed (${status})`);
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again.',
  forbidden: 'Your role is not allowed to do this.',
  csrf_invalid: 'Your session needs a refresh. Reload the page.',
  invalid_credentials: 'Sign-in failed. Check the email, password and code.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  network_error: 'The API could not be reached.',
  timeout: 'The request timed out.',
  kyc_not_pending: 'This profile is no longer pending.',
  kyc_underage: 'The player is under the minimum age and cannot be approved.',
  invalid_range: 'Choose a range of at most one year.',
  correction_reason_required: 'A correction needs a reason.',
  event_not_started: 'The event has not started yet.',
  jackpot_round_not_cancellable: 'This round can no longer be cancelled.',
  payout_not_reviewable: 'This withdrawal is no longer waiting for review.',
  payout_already_closed: 'This payout is already closed.',
};

/** A sentence for an error, using the details of an invalid setting when present. */
export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (
      error.code === 'invalid_setting' &&
      error.details !== null &&
      typeof error.details === 'object'
    ) {
      const issues = (error.details as { issues?: unknown }).issues;
      if (Array.isArray(issues) && issues.length > 0) {
        return `Invalid setting: ${issues.map(String).join('; ')}`;
      }
    }
    return MESSAGES[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
