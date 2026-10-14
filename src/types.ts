import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

export type HexAddress = `0x${string}`;
export type EIP155Network = `eip155:${number}`;

/** The only public payment rail accepted by this adapter. */
export interface BotChainProfile {
  readonly chainId: number;
  readonly network: EIP155Network;
  readonly usdtAddress: HexAddress;
  readonly permit2ProxyAddress: HexAddress;
  readonly rpcUrl?: string;
  readonly facilitatorURL: string;
}

/**
 * A narrow signer boundary. Wallet adapters can implement it without exposing a private key to
 * this package. It intentionally matches the official x402 EVM client's signer requirement.
 */
export interface EvmPayerSigner {
  readonly address: HexAddress;
  signTypedData(message: {
    readonly domain: Record<string, unknown>;
    readonly types: Record<string, unknown>;
    readonly primaryType: string;
    readonly message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export interface PaymentAuthorizationContext {
  readonly requestURL: URL;
  readonly payer: HexAddress;
  readonly requirement: PaymentRequirements;
}

/**
 * A caller can require an interactive approval, a tenant budget decision, or both. Omitting this
 * callback means that constructing the adapter with an explicit fixed profile is the approval.
 */
export type AuthorizePayment = (context: PaymentAuthorizationContext) => boolean | Promise<boolean>;

export interface PayerPolicy {
  readonly maxAmountAtomic?: bigint;
  readonly authorizePayment?: AuthorizePayment;
}

export interface PreflightCheck {
  readonly name: string;
  readonly status: "PASS" | "BLOCKED" | "FAIL" | "UNKNOWN";
  readonly reason?: string;
}

export interface RecoveryAction {
  readonly type: string;
  readonly chain_id: number;
  readonly to: HexAddress;
  readonly selector: `0x${string}`;
}

export interface PreflightResult {
  readonly ready: boolean;
  readonly checks: readonly PreflightCheck[];
  readonly recovery_actions: readonly RecoveryAction[];
  readonly checked_at: string;
  readonly expires_at: string;
  /** True only for a transient diagnostic failure such as an RPC timeout. */
  readonly retryable?: boolean;
}

export interface PreflightClient {
  check(input: {
    readonly paymentRequired: unknown;
    readonly payerAddress: HexAddress;
    readonly accountType: "EOA";
    readonly signal?: AbortSignal;
  }): Promise<PreflightResult>;
}

export interface PaymentAttempt {
  /** The original signed x402 payload. Treat this as sensitive transient state. */
  readonly payload: PaymentPayload;
  /** Re-sends the identical request and signature. It never creates another Permit2 signature. */
  retry(): Promise<PaymentFetchResult>;
}

export type PaymentFetchResult =
  | { readonly kind: "unpaid"; readonly response: Response }
  | { readonly kind: "settled"; readonly response: Response; readonly settlement: SettleResponse }
  | {
      readonly kind: "pending" | "unknown";
      readonly response?: Response;
      readonly attempt: PaymentAttempt;
      readonly cause?: unknown;
    };
