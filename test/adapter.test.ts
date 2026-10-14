import assert from "node:assert/strict";
import test from "node:test";

import { HTTPPreflightClient, ThinPayerAdapter, type EvmPayerSigner, type PreflightClient } from "../src/index.js";

const network = "eip155:968" as const;
const asset = "0x75edC9335175Fc0552D51D48439F229c10420fe3" as const;
const receiver = "0x71d066Eb5C9402BB8bA8ED406D5D51edd320F862" as const;
const proxy = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as const;
const payer = "0x1111111111111111111111111111111111111111" as const;
const providerURL = "https://provider.example/weather";

function paymentRequiredHeader(): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: providerURL },
    accepts: [{
      scheme: "exact",
      network,
      asset,
      amount: "100000",
      payTo: receiver,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "permit2", paymentFlow: "upfront" },
    }],
  })).toString("base64");
}

function supportedResponse(): Response {
  return Response.json({
    kinds: [{ x402Version: 2, scheme: "exact", network, extra: { assetTransferMethod: "permit2", paymentFlow: "upfront" } }],
    extensions: [],
    signers: {},
  });
}

function paymentResponseHeader(): string {
  return Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network, payer, amount: "100000" })).toString("base64");
}

function signer(): { signer: EvmPayerSigner; signed: unknown[] } {
  const signed: unknown[] = [];
  return {
    signed,
    signer: {
      address: payer,
      async signTypedData(message) {
        signed.push(message);
        return "0x" + "11".repeat(65) as `0x${string}`;
      },
    },
  };
}

function adapter(fetchImplementation: typeof fetch, payerSigner: EvmPayerSigner, preflight?: PreflightClient): ThinPayerAdapter {
  return new ThinPayerAdapter({
    profile: {
      chainId: 968,
      network,
      usdtAddress: asset,
      permit2ProxyAddress: proxy,
      facilitatorURL: "https://facilitator.example",
    },
    signer: payerSigner,
    fetch: fetchImplementation,
    preflight,
    policy: { maxAmountAtomic: 100000n },
  });
}

test("signs one Permit2 payload, retries the original request, and parses PAYMENT-RESPONSE", async () => {
  const { signer: payerSigner, signed } = signer();
  const requests: Request[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === providerURL && requests.filter(value => value.url === providerURL).length === 1) {
      return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader() } });
    }
    if (request.url === "https://facilitator.example/supported") {
      return supportedResponse();
    }
    return new Response(JSON.stringify({ weather: "sunny" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": paymentResponseHeader() },
    });
  };

  const result = await adapter(fetchImplementation, payerSigner).fetchWithPayment(providerURL, { method: "POST", body: "{}" });

  assert.equal(result.kind, "settled");
  assert.equal(signed.length, 1);
  assert.equal((signed[0] as { primaryType: string }).primaryType, "PermitWitnessTransferFrom");
  assert.equal(requests.filter(request => request.url === providerURL).length, 2);
  assert.match(requests[2].headers.get("PAYMENT-SIGNATURE") ?? "", /^[A-Za-z0-9+/]+=*$/);
  assert.equal(result.settlement.transaction, "0xabc");
});

test("does not sign when preflight blocks payment", async () => {
  const { signer: payerSigner, signed } = signer();
  const preflight: PreflightClient = {
    async check() {
      return {
        ready: false,
        checks: [{ name: "permit2_allowance", status: "BLOCKED" }],
        recovery_actions: [{ type: "APPROVE_PERMIT2", chain_id: 968, to: asset, selector: "0x095ea7b3" }],
        checked_at: "2026-10-12T00:00:00Z",
        expires_at: "2026-10-12T00:00:30Z",
      };
    },
  };
  const fetchImplementation: typeof fetch = async input => {
    const request = new Request(input);
    if (request.url === providerURL) {
      return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader() } });
    }
    return supportedResponse();
  };

  await assert.rejects(
    () => adapter(fetchImplementation, payerSigner, preflight).fetchWithPayment(providerURL),
    { name: "PreflightBlockedError", code: "PREFLIGHT_BLOCKED" },
  );
  assert.equal(signed.length, 0);
});

test("agentPayURL enables the B5.4 HTTP preflight route without manual client wiring", async () => {
  const { signer: payerSigner, signed } = signer();
  const requests: Request[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === "https://agentpay.example/v1/payments:preflight") {
      return Response.json({
        data: {
          ready: true,
          checks: ["network", "asset", "balance", "permit2_allowance", "gas_for_first_approval"].map(name => ({ name, status: "PASS" })),
          recovery_actions: [],
          checked_at: "2026-10-13T00:00:00Z",
          expires_at: "2026-10-13T00:00:30Z",
          retryable: false,
        },
      });
    }
    if (request.url === "https://facilitator.example/supported") {
      return supportedResponse();
    }
    if (request.headers.get("PAYMENT-SIGNATURE") === null) {
      return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader() } });
    }
    return new Response(null, { status: 200, headers: { "PAYMENT-RESPONSE": paymentResponseHeader() } });
  };
  const payerAdapter = new ThinPayerAdapter({
    profile: { chainId: 968, network, usdtAddress: asset, permit2ProxyAddress: proxy, facilitatorURL: "https://facilitator.example" },
    signer: payerSigner,
    fetch: fetchImplementation,
    agentPayURL: "https://agentpay.example",
    policy: { maxAmountAtomic: 100000n },
  });

  const result = await payerAdapter.fetchWithPayment(providerURL);

  assert.equal(result.kind, "settled");
  assert.equal(signed.length, 1);
  const preflightRequest = requests.find(request => request.url === "https://agentpay.example/v1/payments:preflight");
  assert.ok(preflightRequest);
  assert.match(await preflightRequest.text(), /"account_type":"EOA"/);
});

test("rejects a retryable or unsafe preflight response before creating a signature", async () => {
  const { signer: payerSigner, signed } = signer();
  const retryablePreflight: PreflightClient = {
    async check() {
      return {
        ready: true,
        retryable: true,
        checks: [{ name: "network", status: "PASS" }],
        recovery_actions: [],
        checked_at: "2026-10-13T00:00:00Z",
        expires_at: "2026-10-13T00:00:30Z",
      };
    },
  };
  const fetchImplementation: typeof fetch = async input => {
    const request = new Request(input);
    if (request.url === "https://facilitator.example/supported") return supportedResponse();
    return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader() } });
  };

  await assert.rejects(
    () => adapter(fetchImplementation, payerSigner, retryablePreflight).fetchWithPayment(providerURL),
    { name: "AgentPayPayerError", code: "PREFLIGHT_INVALID" },
  );
  assert.equal(signed.length, 0);

  const unsafeAction: PreflightClient = {
    async check() {
      return {
        ready: false,
        checks: [{ name: "permit2_allowance", status: "BLOCKED" }],
        recovery_actions: [{ type: "APPROVE_PERMIT2", chain_id: 968, to: receiver, selector: "0x095ea7b3" }],
        checked_at: "2026-10-13T00:00:00Z",
        expires_at: "2026-10-13T00:00:30Z",
      };
    },
  };
  await assert.rejects(
    () => adapter(fetchImplementation, payerSigner, unsafeAction).preflight({ x402Version: 2 }),
    { name: "AgentPayPayerError", code: "PREFLIGHT_INVALID" },
  );
});

test("an indeterminate signed retry can only resend the original payment signature", async () => {
  const { signer: payerSigner, signed } = signer();
  let signedRequestCount = 0;
  const paymentHeaders: string[] = [];
  const fetchImplementation: typeof fetch = async input => {
    const request = new Request(input);
    if (request.url === "https://facilitator.example/supported") {
      return supportedResponse();
    }
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (signature === null) {
      return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader() } });
    }
    paymentHeaders.push(signature);
    signedRequestCount += 1;
    if (signedRequestCount === 1) {
      throw new TypeError("connection reset after signed request");
    }
    return new Response(null, { status: 202 });
  };

  const first = await adapter(fetchImplementation, payerSigner).fetchWithPayment(providerURL);
  assert.equal(first.kind, "unknown");
  if (first.kind !== "unknown") throw new Error("expected unknown result");
  const retried = await first.attempt.retry();

  assert.equal(retried.kind, "pending");
  assert.equal(signed.length, 1);
  assert.deepEqual(paymentHeaders, [paymentHeaders[0], paymentHeaders[0]]);
});

test("HTTP preflight returns audited recovery actions without executing them", async () => {
  let requestBody = "";
  const client = HTTPPreflightClient.fromBaseURL("https://agentpay.example", async (_input, init) => {
    requestBody = String(init?.body);
    return Response.json({
      data: {
        ready: false,
        checks: [{ name: "permit2_allowance", status: "BLOCKED" }],
        recovery_actions: [{ type: "APPROVE_PERMIT2", chain_id: 968, to: asset, selector: "0x095ea7b3" }],
        checked_at: "2026-10-12T00:00:00Z",
        expires_at: "2026-10-12T00:00:30Z",
        retryable: true,
      },
    });
  });

  const result = await client.check({ paymentRequired: { x402Version: 2 }, payerAddress: payer, accountType: "EOA" });

  assert.equal(result.ready, false);
  assert.equal(result.retryable, true);
  assert.equal(result.recovery_actions[0].type, "APPROVE_PERMIT2");
  assert.match(requestBody, /payer_address/);
});
