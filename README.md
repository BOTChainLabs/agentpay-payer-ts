# @botchainlabs/agentpay-payer

Thin x402 v2 payer adapter for BOT Chain's public `exact + permit2 + upfront` profile.

The package is intentionally a payer-side adapter only. It signs an EOA Permit2 authorization and
retries the original resource request once. Payment orders, Facilitator settlement, confirmation,
UNKNOWN recovery, and fulfillment remain the Provider SDK and AgentPay service's responsibility.

```ts
import { ThinPayerAdapter } from "@botchainlabs/agentpay-payer";

const payer = new ThinPayerAdapter({
  profile: {
    chainId: 677,
    network: "eip155:677",
    usdtAddress: process.env.BOTCHAIN_USDT as `0x${string}`,
    permit2ProxyAddress: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
    facilitatorURL: "https://facilitator.example",
  },
  signer: walletSigner,
  policy: {
    maxAmountAtomic: 1_000_000n,
    authorizePayment: async context => showPaymentConfirmation(context),
  },
});

const result = await payer.fetchWithPayment("https://provider.example/paid-api");
```

`result.kind === "settled"` includes the decoded `PAYMENT-RESPONSE`. `pending` and `unknown`
include an `attempt.retry()` function that re-sends the identical signed payload; it never creates
another Permit2 signature. Configure `HTTPPreflightClient` once B5.4's
`POST /v1/payments:preflight` route is available. Recovery actions are returned to the caller and
are never automatically executed by this package.

## Compatibility

This adapter supports x402 v2, BOT Chain's public `exact + permit2 + upfront` profile, and EOA-compatible signers. It intentionally excludes Kernel, Session Key, and every private AgentPay profile.

## Security

Configure an explicit `maxAmountAtomic` and `authorizePayment` callback. The adapter never receives a private key: callers supply only a narrow signing interface. See [SECURITY.md](SECURITY.md) for reporting guidance.

## Development

```bash
npm ci
npm test
npm run check
npm run build
```

## License

Apache-2.0. See [LICENSE](LICENSE).
