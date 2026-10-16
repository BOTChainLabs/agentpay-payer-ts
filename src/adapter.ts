import { x402Client, x402HTTPClient } from "@x402/fetch";
import { isPermit2Payload, PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";

import { AgentPayPayerError, PreflightBlockedError } from "./errors.js";
import { HTTPPreflightClient } from "./preflight.js";
import type {
  BotChainProfile,
  EvmPayerSigner,
  PaymentAttempt,
  PaymentFetchResult,
  PayerPolicy,
  PreflightClient,
} from "./types.js";

const supportedCacheTTLMilliseconds = 60_000;

// Browser fetch is a Window-bound Web API. Storing window.fetch directly and later invoking it
// as a plain function loses its receiver, producing "Illegal invocation" before the 402 request
// reaches the Provider. Keep this wrapper rather than a captured method reference.
const defaultFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

export interface ThinPayerAdapterOptions {
  readonly profile: BotChainProfile;
  readonly signer: EvmPayerSigner;
  readonly policy?: PayerPolicy;
  /** AgentPay public base URL. Creates the B5.4 HTTP client automatically. */
  readonly agentPayURL?: string | URL;
  /** Use for a non-HTTP transport or tests. Cannot be combined with agentPayURL. */
  readonly preflight?: PreflightClient;
  readonly fetch?: typeof globalThis.fetch;
  readonly supportedCacheTTLMilliseconds?: number;
}

export interface PaymentFetchOptions {
  /** Defaults to true when a PreflightClient was configured. */
  readonly preflight?: boolean;
}

/**
 * ThinPayerAdapter owns only the payer-side protocol work. It neither creates AgentPay orders
 * nor settles on-chain: the retried request is processed by the Provider SDK and AgentPay.
 */
export class ThinPayerAdapter {
  private readonly profile: BotChainProfile;
  private readonly signer: EvmPayerSigner;
  private readonly policy: PayerPolicy;
  private readonly preflightClient?: PreflightClient;
  private readonly fetchImplementation: typeof fetch;
  private readonly httpClient: x402HTTPClient;
  private readonly supportedCacheTTL: number;
  private supportedAt?: number;

  constructor(options: ThinPayerAdapterOptions) {
    validateProfile(options.profile);
    this.profile = options.profile;
    this.signer = options.signer;
    this.policy = options.policy ?? {};
    this.fetchImplementation = options.fetch ?? defaultFetch;
    if (options.agentPayURL !== undefined && options.preflight !== undefined) {
      throw new AgentPayPayerError("INVALID_CONFIGURATION", "agentPayURL and preflight cannot be configured together");
    }
    this.preflightClient = options.preflight ?? (options.agentPayURL === undefined
      ? undefined
      : HTTPPreflightClient.fromBaseURL(options.agentPayURL, this.fetchImplementation));
    this.supportedCacheTTL = options.supportedCacheTTLMilliseconds ?? supportedCacheTTLMilliseconds;
    if (!Number.isSafeInteger(this.supportedCacheTTL) || this.supportedCacheTTL < 1) {
      throw new AgentPayPayerError("INVALID_CONFIGURATION", "supported capability cache TTL must be positive");
    }

    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: this.signer,
      networks: [this.profile.network],
      ...(this.profile.rpcUrl === undefined ? {} : { schemeOptions: { [this.profile.chainId]: { rpcUrl: this.profile.rpcUrl } } }),
    });
    // BOT Chain USDT is not in the upstream default-asset table. Register it explicitly so the
    // official client's own spend controls remain active instead of disabling them globally.
    client.setSpendControls({
      allowedAssets: [{
        network: this.profile.network,
        asset: this.profile.usdtAddress,
        ...(this.policy.maxAmountAtomic === undefined ? {} : { maxAmountPerPayment: this.policy.maxAmountAtomic.toString() }),
      }],
    });
    this.httpClient = new x402HTTPClient(client);
  }

  async preflight(paymentRequired: unknown, signal?: AbortSignal) {
    if (this.preflightClient === undefined) {
      throw new AgentPayPayerError("PREFLIGHT_NOT_CONFIGURED", "preflight is not configured for this payer adapter");
    }
    const result = await this.preflightClient.check({ paymentRequired, payerAddress: this.signer.address, accountType: "EOA", signal });
    this.assertPreflightResult(result);
    return result;
  }

  /** Sends an unpaid request once, then exactly once more with a signed PAYMENT-SIGNATURE on 402. */
  async fetchWithPayment(
    input: RequestInfo | URL,
    init?: RequestInit,
    options: PaymentFetchOptions = {},
  ): Promise<PaymentFetchResult> {
    const original = new Request(input, init);
    const firstResponse = await this.fetchImplementation(original.clone());
    if (firstResponse.status !== 402) {
      return { kind: "unpaid", response: firstResponse };
    }

    const required = this.decodePaymentRequired(firstResponse);
    const requirement = this.selectRequirement(required, original.url);
    await this.ensureFacilitatorSupports(requirement);

    if (options.preflight ?? this.preflightClient !== undefined) {
      const result = await this.preflight(required, original.signal);
      if (!result.ready || result.retryable === true) {
        throw new PreflightBlockedError(result);
      }
    }

    await this.authorizePayment(requirement, original.url);
    const payload = await this.httpClient.createPaymentPayload(required);
    this.assertPayload(payload, requirement);
    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(payload);
    return this.sendSignedRequest(original, payload, paymentHeaders);
  }

  private decodePaymentRequired(response: Response): PaymentRequired {
    try {
      return this.httpClient.getPaymentRequiredResponse(name => response.headers.get(name));
    } catch (cause) {
      throw new AgentPayPayerError("PAYMENT_REQUIRED_INVALID", "402 response has no valid PAYMENT-REQUIRED header", { cause });
    }
  }

  private selectRequirement(required: PaymentRequired, requestURL: string): PaymentRequirements {
    if (required.x402Version !== 2 || required.resource === undefined || !sameResource(required.resource.url, requestURL)) {
      throw new AgentPayPayerError("PAYMENT_PROFILE_UNSUPPORTED", "402 resource does not bind to the requested URL");
    }
    const matching = required.accepts.filter(requirement => this.matchesProfile(requirement));
    if (matching.length !== 1) {
      throw new AgentPayPayerError("PAYMENT_PROFILE_UNSUPPORTED", "402 must offer exactly one supported BOT Chain profile");
    }
    return matching[0];
  }

  private matchesProfile(requirement: PaymentRequirements): boolean {
    return requirement.scheme === "exact" && requirement.network === this.profile.network &&
      sameAddress(requirement.asset, this.profile.usdtAddress) && isAtomicAmount(requirement.amount) && BigInt(requirement.amount) > 0n &&
      isAddress(requirement.payTo) && requirement.extra.assetTransferMethod === "permit2" && requirement.extra.paymentFlow === "upfront";
  }

  private async authorizePayment(requirement: PaymentRequirements, requestURL: string): Promise<void> {
    if (this.policy.maxAmountAtomic !== undefined && BigInt(requirement.amount) > this.policy.maxAmountAtomic) {
      throw new AgentPayPayerError("PAYMENT_NOT_AUTHORIZED", "payment amount exceeds the configured payer limit");
    }
    if (this.policy.authorizePayment !== undefined) {
      const approved = await this.policy.authorizePayment({ requestURL: new URL(requestURL), payer: this.signer.address, requirement });
      if (!approved) {
        throw new AgentPayPayerError("PAYMENT_NOT_AUTHORIZED", "payment was rejected by the payer policy");
      }
    }
  }

  private assertPreflightResult(result: Awaited<ReturnType<PreflightClient["check"]>>): void {
    const checkedAt = Date.parse(result.checked_at);
    const expiresAt = Date.parse(result.expires_at);
    if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || expiresAt <= checkedAt) {
      throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight response contains invalid timestamps");
    }
    for (const check of result.checks) {
      if (!["PASS", "BLOCKED", "FAIL", "UNKNOWN"].includes(check.status)) {
        throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight response contains an invalid check status");
      }
    }
    for (const action of result.recovery_actions) {
      if (action.type !== "APPROVE_PERMIT2" || action.chain_id !== this.profile.chainId ||
          !sameAddress(action.to, this.profile.usdtAddress) || action.selector.toLowerCase() !== "0x095ea7b3") {
        throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight response contains an unaudited recovery action");
      }
    }
    if (result.ready && (result.retryable === true || result.checks.some(check => check.status !== "PASS") || result.recovery_actions.length !== 0)) {
      throw new AgentPayPayerError("PREFLIGHT_INVALID", "preflight marked an incomplete result as ready");
    }
  }

  private assertPayload(payload: PaymentPayload, requirement: PaymentRequirements): void {
    // The core wire type intentionally keeps payload as a generic object. The official EVM guard
    // narrows it below; the cast is the protocol boundary, not a hand-written payload parser.
    const evmPayload = payload.payload as Parameters<typeof isPermit2Payload>[0];
    if (payload.x402Version !== 2 || !sameRequirement(payload.accepted, requirement) || !isPermit2Payload(evmPayload)) {
      throw new AgentPayPayerError("PAYMENT_PAYLOAD_INVALID", "official x402 client produced an unexpected payment payload");
    }
    const authorization = evmPayload.permit2Authorization;
    if (!sameAddress(authorization.permitted.token, requirement.asset) || authorization.permitted.amount !== requirement.amount ||
        !sameAddress(authorization.spender, this.profile.permit2ProxyAddress) || !sameAddress(authorization.witness.to, requirement.payTo)) {
      throw new AgentPayPayerError("PAYMENT_PAYLOAD_INVALID", "Permit2 authorization does not match the selected payment requirement");
    }
  }

  private async sendSignedRequest(original: Request, payload: PaymentPayload, paymentHeaders: Record<string, string>): Promise<PaymentFetchResult> {
    const send = async (): Promise<PaymentFetchResult> => {
      let response: Response;
      try {
        response = await this.fetchImplementation(withHeaders(original, paymentHeaders));
      } catch (cause) {
        return { kind: "unknown", attempt: this.makeAttempt(original, payload, paymentHeaders), cause };
      }
      if (response.status === 202) {
        return { kind: "pending", response, attempt: this.makeAttempt(original, payload, paymentHeaders) };
      }
      if (response.status === 402) {
        throw new AgentPayPayerError("PAYMENT_RETRY_REJECTED", "provider rejected the signed payment retry; a new signature was not created");
      }
      const header = response.headers.get("PAYMENT-RESPONSE");
      if (header === null) {
        const cause = new AgentPayPayerError(
          "PAYMENT_RESPONSE_MISSING",
          `paid provider response is missing PAYMENT-RESPONSE (HTTP ${response.status})`,
          { status: response.status, retryable: response.status >= 500 },
        );
        // Provider 5xx can occur after an order has been prepared or broadcast. It is not safe
        // to create a second Permit2 signature, but retrying the original signed request is safe.
        if (response.status >= 500) {
          return { kind: "unknown", response, attempt: this.makeAttempt(original, payload, paymentHeaders), cause };
        }
        const reason = await providerRejectionCode(response.clone());
        throw new AgentPayPayerError(
          "PAYMENT_RETRY_REJECTED",
          reason === undefined
            ? `provider rejected the signed payment retry (HTTP ${response.status})`
            : `provider rejected the signed payment retry: ${reason} (HTTP ${response.status})`,
          { status: response.status, retryable: false, cause },
        );
      }
      try {
        const result = await this.httpClient.processPaymentResult(payload, name => response.headers.get(name), response.status);
        if (result.settleResponse === undefined || result.recovered) {
          throw new Error("unexpected x402 settlement result");
        }
        return { kind: "settled", response, settlement: result.settleResponse };
      } catch (cause) {
        throw new AgentPayPayerError("PAYMENT_RESPONSE_INVALID", "provider returned an invalid PAYMENT-RESPONSE", { cause });
      }
    };
    return send();
  }

  private makeAttempt(original: Request, payload: PaymentPayload, paymentHeaders: Record<string, string>): PaymentAttempt {
    return { payload, retry: () => this.sendSignedRequest(original, payload, paymentHeaders) };
  }

  private async ensureFacilitatorSupports(requirement: PaymentRequirements): Promise<void> {
    if (this.supportedAt !== undefined && Date.now() - this.supportedAt < this.supportedCacheTTL) {
      return;
    }
    const response = await this.fetchImplementation(new URL("/supported", this.profile.facilitatorURL), { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new AgentPayPayerError("FACILITATOR_UNAVAILABLE", `facilitator capability request failed with HTTP ${response.status}`);
    }
    let supported: unknown;
    try {
      supported = await response.json();
    } catch (cause) {
      throw new AgentPayPayerError("FACILITATOR_INVALID", "facilitator capability response is not JSON", { cause });
    }
    if (!supportsRequirement(supported, requirement)) {
      throw new AgentPayPayerError("PAYMENT_PROFILE_UNSUPPORTED", "facilitator does not support the selected BOT Chain payment profile");
    }
    this.supportedAt = Date.now();
  }
}

function validateProfile(profile: BotChainProfile): void {
  if (!Number.isSafeInteger(profile.chainId) || profile.chainId < 1 || profile.network !== `eip155:${profile.chainId}` ||
      !isAddress(profile.usdtAddress) || !isAddress(profile.permit2ProxyAddress) || !isHTTPURL(profile.facilitatorURL)) {
    throw new AgentPayPayerError("INVALID_CONFIGURATION", "BOT Chain profile is invalid");
  }
  if (!sameAddress(PERMIT2_ADDRESS, "0x000000000022D473030F116dDEE9F6B43aC78BA3") ||
      !sameAddress(profile.permit2ProxyAddress, x402ExactPermit2ProxyAddress)) {
    throw new AgentPayPayerError("INVALID_CONFIGURATION", "installed x402 EVM package has an unexpected Permit2 address");
  }
}

function withHeaders(original: Request, paymentHeaders: Record<string, string>): Request {
  const headers = new Headers(original.headers);
  for (const [name, value] of Object.entries(paymentHeaders)) {
    headers.set(name, value);
  }
  return new Request(original.clone(), { headers });
}

function supportsRequirement(value: unknown, requirement: PaymentRequirements): boolean {
  if (!isRecord(value) || !Array.isArray(value.kinds)) {
    return false;
  }
  return value.kinds.some(kind => isRecord(kind) && kind.x402Version === 2 && kind.scheme === requirement.scheme &&
    kind.network === requirement.network && isRecord(kind.extra) && kind.extra.assetTransferMethod === "permit2" && kind.extra.paymentFlow === "upfront");
}

// A Provider error body is not protocol data. Surface only a short, machine-readable
// code so browser users can distinguish a terminal validation rejection from an
// UNKNOWN settlement result without rendering arbitrary server diagnostics.
async function providerRejectionCode(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value)) return undefined;
    for (const key of ["reason", "detail"]) {
      const code = value[key];
      if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(code)) return code;
    }
  } catch {
    // A non-JSON rejection remains a terminal provider rejection; its HTTP status is enough.
  }
  return undefined;
}

function sameResource(resourceURL: string, requestURL: string): boolean {
  try {
    const resource = new URL(resourceURL);
    const request = new URL(requestURL);
    return resource.origin === request.origin && resource.pathname === request.pathname;
  } catch {
    return false;
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameRequirement(left: PaymentRequirements, right: PaymentRequirements): boolean {
  return left.scheme === right.scheme && left.network === right.network && left.asset === right.asset &&
    left.amount === right.amount && left.payTo === right.payTo &&
    left.extra.assetTransferMethod === right.extra.assetTransferMethod && left.extra.paymentFlow === right.extra.paymentFlow;
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isAtomicAmount(value: string): boolean {
  return /^\d+$/.test(value);
}

function isHTTPURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
