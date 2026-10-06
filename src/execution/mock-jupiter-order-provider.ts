import type {
  JupiterOrder,
  JupiterOrderProvider,
  JupiterOrderRequest,
} from "./jupiter-order-adapter.js";

export class MockJupiterOrderProvider implements JupiterOrderProvider {
  readonly requests: JupiterOrderRequest[] = [];

  constructor(
    private readonly outputNumerator = 1n,
    private readonly outputDenominator = 1n,
  ) {}

  async getOrder(request: JupiterOrderRequest): Promise<JupiterOrder> {
    const monotonicNs = process.hrtime.bigint();
    this.requests.push(request);
    return {
      requestId: `mock-${this.requests.length}`,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputRaw: request.amount,
      expectedOutputRaw:
        (request.amount * this.outputNumerator) / this.outputDenominator,
      router: "mock",
      mode: "shadow",
      feeBps: 0,
      feeMint: request.inputMint,
      priceImpactPct: "0",
      route: [{ provider: "MOCK" }],
      responseTimestampMs: Date.now(),
      requestTimestampMs: Date.now(),
      requestMonotonicNs: monotonicNs,
      responseMonotonicNs: monotonicNs,
      httpStatus: 200,
      schemaValid: true,
      hasAssembledTransaction: false,
    };
  }
}
