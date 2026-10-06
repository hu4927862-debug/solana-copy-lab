import tls from "node:tls";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedJupiterFetch } from "../../src/network/isolated-jupiter-fetch.js";
import { createIsolatedResolver } from "../../src/network/v6-isolated-dns.js";
import { JupiterOrderAdapter } from "../../src/execution/jupiter-order-adapter.js";
const url = "https://api.jup.ag/swap/v2/order";
const request = {
  inputMint: "SOL_NATIVE",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 500000n,
};
// Replace only the TLS socket boundary. Native fetch, Agent, lookup, HTTP parsing and body cancellation remain real.
function socketBoundary(response: string) {
  let sent = 0;
  let socket!: Duplex;
  const connect = vi.spyOn(tls, "connect").mockImplementation(((
    options: tls.ConnectionOptions,
  ) => {
    socket = Object.assign(
      new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          sent++;
          this.push(response);
          callback();
        },
      }),
      {
        authorized: true,
        encrypted: true,
        connecting: false,
        setNoDelay() {
          return this;
        },
        setKeepAlive() {
          return this;
        },
        ref() {
          return this;
        },
        unref() {
          return this;
        },
      },
    );
    expect(options.rejectUnauthorized).toBe(true);
    queueMicrotask(() =>
      options.lookup!("api.jup.ag", { all: true }, (error) => {
        if (error) socket.destroy(error);
        else socket.emit("secureConnect");
      }),
    );
    return socket as tls.TLSSocket;
  }) as typeof tls.connect);
  const query = vi.fn(async (host: string, type: number) => ({
    Status: 0,
    TC: false,
    Question: [{ name: host, type }],
    Answer:
      type === 1 ? [{ name: host, type, TTL: 60, data: "192.0.2.1" }] : [],
  }));
  const resolver = createIsolatedResolver({ query });
  return { connect, query, resolver, sent: () => sent, socket: () => socket };
}
afterEach(() => vi.restoreAllMocks());
describe("production native HTTP transport fault boundary", () => {
  it("does not retry a Jupiter HTTP 429 after actual lookup and transmission", async () => {
    const network = socketBoundary(
      "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\n\r\n{}",
    );
    const fetcher = createIsolatedJupiterFetch({ resolver: network.resolver });
    try {
      await expect(
        new JupiterOrderAdapter("DUMMY", fetcher).getOrder(request),
      ).rejects.toMatchObject({ telemetry: { httpStatus: 429 } });
      expect(network.query).toHaveBeenCalledTimes(2);
      expect(network.connect).toHaveBeenCalledTimes(1);
      expect(network.sent()).toBe(1);
    } finally {
      await fetcher.close();
    }
  });
  it("cancels an unfinished response body and destroys its connection", async () => {
    const network = socketBoundary(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    const fetcher = createIsolatedJupiterFetch({ resolver: network.resolver });
    const controller = new AbortController();
    try {
      const response = await fetcher(url, { signal: controller.signal });
      const failed = expect(response.text()).rejects.toBeDefined();
      controller.abort();
      await failed;
      await new Promise((resolve) => setImmediate(resolve));
      expect(network.socket().destroyed).toBe(true);
      expect(network.sent()).toBe(1);
    } finally {
      await fetcher.close();
    }
  });
  it("factory shutdown cancels pending A and AAAA and rejects later requests", async () => {
    const signals: AbortSignal[] = [];
    let began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const resolver = createIsolatedResolver({
      query: async (_h, _t, signal) => {
        signals.push(signal);
        began();
        return new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    });
    const fetcher = createIsolatedJupiterFetch({ resolver });
    const failed = expect(fetcher(url)).rejects.toMatchObject({
      name: "AbortError",
    });
    await started;
    await fetcher.close();
    await failed;
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    await expect(fetcher(url)).rejects.toThrow("JUPITER_FETCH_CLOSED");
  });
});
