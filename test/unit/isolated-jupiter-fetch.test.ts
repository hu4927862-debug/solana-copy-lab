import { describe, expect, it, vi } from "vitest";
import { createIsolatedJupiterFetch } from "../../src/network/isolated-jupiter-fetch.js";
import { createIsolatedResolver } from "../../src/network/v6-isolated-dns.js";
import { JupiterOrderAdapter } from "../../src/execution/jupiter-order-adapter.js";

const request = {
  inputMint: "SOL_NATIVE",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 500000n,
};
describe("production Jupiter fetch", () => {
  it("invokes the real custom lookup through native fetch and propagates DNS failure without another Jupiter request", async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error("PRIVATE_UPSTREAM_TEXT"), {
        code: "ENOTFOUND",
      });
    });
    const resolver = createIsolatedResolver({ query });
    const lookup = vi.spyOn(resolver, "lookupFor");
    const fetcher = createIsolatedJupiterFetch({ resolver });
    try {
      await expect(
        new JupiterOrderAdapter("DUMMY", fetcher).getOrder(request),
      ).rejects.toMatchObject({
        telemetry: { transportErrorCode: "ENOTFOUND" },
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(2); // A and AAAA, not two quote attempts.
    } finally {
      await fetcher.close?.();
    }
  });
  it("cancels actual in-flight resolver work when the request is aborted", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const signals: AbortSignal[] = [];
    const resolver = createIsolatedResolver({
      query: async (_host, _type, signal) => {
        signals.push(signal);
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    });
    const fetcher = createIsolatedJupiterFetch({ resolver });
    const controller = new AbortController();
    const result = fetcher("https://api.jup.ag/swap/v2/order", {
      method: "GET",
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await began;
    controller.abort();
    await rejected;
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await fetcher.close?.();
  });
});
