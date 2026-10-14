/** Stable errors surfaced by the payer adapter. Error messages never contain a payment signature. */
export interface AgentPayPayerErrorOptions extends ErrorOptions {
  readonly retryable?: boolean;
  readonly status?: number;
}

export class AgentPayPayerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: AgentPayPayerErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentPayPayerError";
    this.retryable = options?.retryable;
    this.status = options?.status;
  }

  readonly retryable?: boolean;
  readonly status?: number;
}

export class PreflightBlockedError extends AgentPayPayerError {
  constructor(public readonly result: unknown) {
    super("PREFLIGHT_BLOCKED", "payment preflight did not pass");
    this.name = "PreflightBlockedError";
  }
}
