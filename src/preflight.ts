import { AgentPayPayerError } from "./errors.js";
import type { HexAddress, PreflightClient, PreflightResult, RecoveryAction } from "./types.js";

const maxPreflightResponseBytes = 128 * 1024;

/** HTTP client for B5.4. It is optional in the adapter because the server route is delivered separately. */
export class HTTPPreflightClient implements PreflightClient {
  constructor(
    private readonly endpoint: URL,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {}

  static fromBaseURL(baseURL: string | URL, fetchImplementation?: typeof fetch): HTTPPreflightClient {
    return new HTTPPreflightClient(new URL("/v1/payments:preflight", baseURL), fetchImplementation);
  }

  async check(input: {
    readonly paymentRequired: unknown;
    readonly payerAddress: HexAddress;
    readonly accountType: "EOA";
    readonly signal?: AbortSignal;
  }): Promise<PreflightResult> {
    const response = await this.fetchImplementation(this.endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        payment_required: input.paymentRequired,
        payer_address: input.payerAddress,
        account_type: input.accountType,
      }),
      signal: input.signal,
    });
    const text = await readLimitedText(response, maxPreflightResponseBytes);
    if (!response.ok) {
      throw parsePreflightError(response.status, text);
    }
    return parsePreflightResponse(text);
  }
}

function parsePreflightError(status: number, text: string): AgentPayPayerError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") {
      return new AgentPayPayerError(parsed.error.code, "preflight request was rejected", {
        retryable: parsed.error.retryable === true,
        status,
      });
    }
  } catch {
    // Preserve the stable fallback below; remote bodies are not safe error messages.
  }
  return new AgentPayPayerError("PREFLIGHT_UNAVAILABLE", `preflight request failed with HTTP ${status}`, {
    retryable: status >= 500,
    status,
  });
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight response is too large");
  }
  return text;
}

function parsePreflightResponse(text: string): PreflightResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight response is not JSON");
  }
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
  if (!isRecord(data) || typeof data.ready !== "boolean" || !Array.isArray(data.checks) || !Array.isArray(data.recovery_actions) ||
      typeof data.checked_at !== "string" || typeof data.expires_at !== "string") {
    throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight response has an invalid shape");
  }
  const checks = data.checks.map((check): PreflightResult["checks"][number] => {
    if (!isRecord(check) || typeof check.name !== "string" || !isCheckStatus(check.status)) {
      throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight check has an invalid shape");
    }
    return { name: check.name, status: check.status, ...(typeof check.reason === "string" ? { reason: check.reason } : {}) };
  });
  const recoveryActions = data.recovery_actions.map(parseRecoveryAction);
  return {
    ready: data.ready,
    checks,
    recovery_actions: recoveryActions,
    checked_at: data.checked_at,
    expires_at: data.expires_at,
    ...(typeof data.retryable === "boolean" ? { retryable: data.retryable } : {}),
  };
}

function parseRecoveryAction(value: unknown): RecoveryAction {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.chain_id !== "number" || !isAddress(value.to) || !isHex(value.selector)) {
    throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight recovery action has an invalid shape");
  }
  return { type: value.type, chain_id: value.chain_id, to: value.to, selector: value.selector };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCheckStatus(value: unknown): value is PreflightResult["checks"][number]["status"] {
  return value === "PASS" || value === "BLOCKED" || value === "FAIL" || value === "UNKNOWN";
}

function isAddress(value: unknown): value is HexAddress {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}
