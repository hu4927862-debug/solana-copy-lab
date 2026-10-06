import { describe, expect, it, vi } from "vitest";
import { createIsolatedResolver } from "../../src/network/v6-isolated-dns.js";

const answer = (type: number, ttl = 60) => ({
  Status: 0,
  TC: false,
  Question: [{ name: "api.jup.ag.", type }],
  Answer:
    type === 1
      ? [
          { name: "api.jup.ag.", type: 5, TTL: ttl, data: "edge.example." },
          { name: "edge.example.", type: 1, TTL: ttl, data: "3.173.219.32" },
        ]
      : [],
});
const ipv6Answer = (ttl = 60) => ({
  ...answer(28, ttl),
  Answer: [{ name: "api.jup.ag.", type: 28, TTL: ttl, data: "2606:4700::1111" }],
});
const dnsTimeout = () => Object.assign(Error("DOH_TIMEOUT"), { code: "ETIMEDOUT" });

describe("V6 process-isolated resolver", () => {
  it("uses a validated fresh IPv4 answer when only the bounded AAAA lookup times out", async () => {
    const query = vi.fn(async (_host: string, type: number) => {
      if (type === 28) throw dnsTimeout();
      return answer(type);
    });
    const resolver = createIsolatedResolver({ query });
    await expect(resolver.resolve("api.jup.ag")).resolves.toEqual([{ address: "3.173.219.32", family: 4 }]);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("uses validated IPv6 when only A times out, while honoring the requested address family", async () => {
    const query = vi.fn(async (_host: string, type: number) => {
      if (type === 1) throw dnsTimeout();
      return ipv6Answer();
    });
    const resolver = createIsolatedResolver({ query });
    await expect(resolver.resolve("api.jup.ag")).resolves.toEqual([{ address: "2606:4700::1111", family: 6 }]);
    const selected = await new Promise((resolve, reject) => {
      resolver.lookup("api.jup.ag", { family: 6, all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
    });
    expect(selected).toEqual([{ address: "2606:4700::1111", family: 6 }]);
    const missing = new Promise((resolve, reject) => {
      resolver.lookup("api.jup.ag", { family: 4 }, (error, address) => error ? reject(error) : resolve(address));
    });
    await expect(missing).rejects.toThrow("DOH_NO_REQUESTED_FAMILY");
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a NOERROR empty AAAA response for usable addresses when A timed out", async () => {
    const query = vi.fn(async (_host: string, type: number) => {
      if (type === 1) throw dnsTimeout();
      return answer(28);
    });
    await expect(createIsolatedResolver({ query }).resolve("api.jup.ag")).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("both family timeouts remain a failure with no additional lookup attempts", async () => {
    const query = vi.fn(async () => { throw dnsTimeout(); });
    await expect(createIsolatedResolver({ query }).resolve("api.jup.ag")).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["TLS certificate", "ERR_TLS_CERT_ALTNAME_INVALID"],
    ["HTTP contract", "ENOTFOUND"],
    ["connection reset", "ECONNRESET"],
    ["caller abort", "ABORT_ERR"],
  ])("a valid family does not hide the sibling %s failure", async (_label, code) => {
    const query = vi.fn(async (_host: string, type: number) => {
      if (type === 28) throw Object.assign(Error("DOH_OTHER_FAILURE"), { code });
      return answer(type);
    });
    await expect(createIsolatedResolver({ query }).resolve("api.jup.ag")).rejects.toThrow("DOH_OTHER_FAILURE");
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["malformed", () => ({})],
    ["truncated", () => ({ ...answer(28), TC: true })],
    ["wrong question", () => ({ ...answer(28), Question: [{ name: "wrong.example", type: 28 }] })],
    ["wrong family address", () => ({ ...ipv6Answer(), Answer: [{ name: "api.jup.ag", type: 28, TTL: 60, data: "3.173.219.32" }] })],
    ["CNAME loop", () => ({ ...answer(28), Answer: [{ name: "api.jup.ag", type: 5, TTL: 60, data: "api.jup.ag" }] })],
  ] as const)("a valid IPv4 address does not hide a %s AAAA contract", async (_label, body) => {
    const query = vi.fn(async (_host: string, type: number) => type === 28 ? body() : answer(type));
    await expect(createIsolatedResolver({ query }).resolve("api.jup.ag")).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("partial-family success caches only fresh validated addresses under the original shortest CNAME TTL", async () => {
    let now = 0;
    const query = vi.fn(async (_host: string, type: number) => {
      if (type === 28) throw dnsTimeout();
      const body = answer(1, 60);
      body.Answer[0]!.TTL = 1;
      if (now > 0) body.Answer[1]!.data = "3.173.219.68";
      return body;
    });
    const resolver = createIsolatedResolver({ query, now: () => now });
    expect((await resolver.resolve("api.jup.ag"))[0]!.address).toBe("3.173.219.32");
    now = 500;
    expect((await resolver.resolve("api.jup.ag"))[0]!.address).toBe("3.173.219.32");
    expect(query).toHaveBeenCalledTimes(2);
    now = 1001;
    expect((await resolver.resolve("api.jup.ag"))[0]!.address).toBe("3.173.219.68");
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("caller cancellation cannot return or cache a successful sibling while the other lookup remains pending", async () => {
    let finishSibling: (() => void) | undefined;
    const query = vi.fn(async (_host: string, type: number) => {
      if (type === 1) return answer(type);
      await new Promise<void>(resolve => { finishSibling = resolve; });
      return answer(type);
    });
    const resolver = createIsolatedResolver({ query });
    const controller = new AbortController();
    const first = resolver.resolve("api.jup.ag", controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    finishSibling!();
    await new Promise(resolve => setImmediate(resolve));
    const next = resolver.resolve("api.jup.ag");
    finishSibling!();
    await expect(next).resolves.toEqual([{ address: "3.173.219.32", family: 4 }]);
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("cancels an abandoned refresh without caching its result or cancelling another consumer", async () => {
    const signals: AbortSignal[] = [];
    const completions: (() => void)[] = [];
    const resolver = createIsolatedResolver({
      query: async (_host, type, signal) => {
        signals.push(signal);
        await new Promise<void>((resolve) => completions.push(resolve));
        return answer(type);
      },
    });
    const first = new AbortController();
    const second = new AbortController();
    const one = resolver.resolve("api.jup.ag", first.signal);
    const two = resolver.resolve("api.jup.ag", second.signal);
    const rejectedOne = expect(one).rejects.toMatchObject({
      name: "AbortError",
    });
    first.abort();
    await rejectedOne;
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    const rejectedTwo = expect(two).rejects.toMatchObject({
      name: "AbortError",
    });
    second.abort();
    await rejectedTwo;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    completions.forEach((complete) => complete());
    await new Promise((resolve) => setImmediate(resolve));
    const third = resolver.resolve("api.jup.ag");
    expect(signals).toHaveLength(4);
    completions.slice(2).forEach((complete) => complete());
    await expect(third).resolves.toEqual([
      { address: "3.173.219.32", family: 4 },
    ]);
  });
  it("uses authenticated answers, expires the entire chain and fails closed when refresh fails", async () => {
    let now = 0;
    const query = vi.fn(async (_host: string, type: number) => answer(type, 2));
    const resolver = createIsolatedResolver({ query, now: () => now });
    expect(await resolver.resolve("api.jup.ag")).toEqual([
      { address: "3.173.219.32", family: 4 },
    ]);
    now = 1000;
    expect(await resolver.resolve("api.jup.ag")).toEqual([
      { address: "3.173.219.32", family: 4 },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    now = 2001;
    query.mockRejectedValue(new Error("DOH_UNAVAILABLE"));
    await expect(resolver.resolve("api.jup.ag")).rejects.toThrow(
      "DOH_UNAVAILABLE",
    );
    await expect(resolver.resolve("unapproved.example")).rejects.toThrow(
      "HOST_NOT_ALLOWED",
    );
  });

  it.each([
    [
      "wrong question",
      (body: ReturnType<typeof answer>) => ({
        ...body,
        Question: [{ name: "other.example", type: 1 }],
      }),
    ],
    [
      "unbound unrelated answers",
      (body: ReturnType<typeof answer>) => ({
        ...body,
        Answer: [
          { name: "unrelated.example", type: 1, TTL: 60, data: "3.173.219.32" },
        ],
      }),
    ],
    [
      "CNAME loop",
      (body: ReturnType<typeof answer>) => ({
        ...body,
        Answer: [{ name: "api.jup.ag", type: 5, TTL: 60, data: "api.jup.ag" }],
      }),
    ],
    [
      "truncated response",
      (body: ReturnType<typeof answer>) => ({ ...body, TC: true }),
    ],
    [
      "negative DNS status",
      (body: ReturnType<typeof answer>) => ({ ...body, Status: 3 }),
    ],
  ])("rejects %s without returning an address", async (_label, mutate) => {
    const resolver = createIsolatedResolver({
      query: async (_host, type) =>
        type === 1 ? mutate(answer(type)) : answer(type),
    });
    await expect(resolver.resolve("api.jup.ag")).rejects.toThrow();
  });

  it("honors a shorter CNAME TTL and refreshes to a new address instead of pinning CDN IPs", async () => {
    let now = 0;
    const query = vi.fn(async (_host: string, type: number) => {
      const body = answer(type);
      if (type === 1) {
        body.Answer[0]!.TTL = 1;
        body.Answer[1]!.data = now === 0 ? "3.173.219.32" : "3.173.219.68";
      }
      return body;
    });
    const resolver = createIsolatedResolver({ query, now: () => now });
    expect((await resolver.resolve("api.jup.ag"))[0]!.address).toBe(
      "3.173.219.32",
    );
    now = 1001;
    expect((await resolver.resolve("api.jup.ag"))[0]!.address).toBe(
      "3.173.219.68",
    );
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("satisfies the Node all-address lookup contract and coalesces simultaneous refreshes", async () => {
    const query = vi.fn(async (_host: string, type: number) => answer(type));
    const resolver = createIsolatedResolver({ query });
    const result = await Promise.all(
      [1, 2].map(
        () =>
          new Promise((resolve, reject) => {
            resolver.lookup("api.jup.ag", { all: true }, (error, addresses) =>
              error ? reject(error) : resolve(addresses),
            );
          }),
      ),
    );
    expect(result).toEqual([
      [{ address: "3.173.219.32", family: 4 }],
      [{ address: "3.173.219.32", family: 4 }],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
