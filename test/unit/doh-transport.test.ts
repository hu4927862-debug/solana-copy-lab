import https, { type RequestOptions } from "node:https";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryDoh } from "../../src/network/v6-isolated-dns.js";

const good = JSON.stringify({
  Status: 0,
  TC: false,
  Question: [{ name: "api.jup.ag", type: 1 }],
  Answer: [{ name: "api.jup.ag", type: 1, TTL: 60, data: "3.173.219.32" }],
});
type Outcome = Error | "HANG" | { status: number; body: string };
function network(outcomes: Outcome[]) {
  const requests: (EventEmitter & { destroyed: boolean })[] = [];
  const spy = vi.spyOn(https, "request").mockImplementation(((
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    expect(options.hostname).toBe("cloudflare-dns.com");
    expect(options.rejectUnauthorized).toBe(true);
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      end() {},
      destroy(_error?: Error) {
        return req;
      },
    });
    const outcome = outcomes[requests.length] ?? outcomes.at(-1)!;
    requests.push(req);
    req.destroy = (error?: Error) => {
      if (!req.destroyed) {
        req.destroyed = true;
        queueMicrotask(() => {
          if (error) req.emit("error", error);
          req.emit("close");
        });
      }
      return req;
    };
    req.end = () =>
      queueMicrotask(() => {
        if (outcome === "HANG" || req.destroyed) return;
        if (outcome instanceof Error) {
          req.destroy(outcome);
          return;
        }
        const response = Object.assign(new EventEmitter(), {
          statusCode: outcome.status,
          destroy() {},
        });
        callback(response as IncomingMessage);
        response.emit("data", Buffer.from(outcome.body));
        response.emit("end");
        req.emit("close");
      });
    return req as unknown as ClientRequest;
  }) as typeof https.request);
  return { spy, requests };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("authenticated DoH retry boundary", () => {
  it("does not retry a certificate hostname failure", async () => {
    const { spy } = network([
      Object.assign(new Error("sensitive upstream text"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
    ]);
    await expect(queryDoh("api.jup.ag", 1)).rejects.toMatchObject({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("destroys an in-flight DNS request immediately on cancellation and never retries it", async () => {
    const { spy, requests } = network(["HANG"]);
    const controller = new AbortController();
    const result = queryDoh(
      "api.jup.ag",
      1,
      "cloudflare",
      () => {},
      controller.signal,
    );
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(requests.every((request) => request.destroyed)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("retries a reset once, without leaking upstream error text into telemetry", async () => {
    const { spy } = network([
      Object.assign(new Error("SECRET"), { code: "ECONNRESET" }),
      { status: 200, body: good },
    ]);
    const audit: unknown[] = [];
    await expect(
      queryDoh("api.jup.ag", 1, "cloudflare", (record) => audit.push(record)),
    ).resolves.toMatchObject({ Status: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(audit)).not.toContain("SECRET");
    expect(audit).toContainEqual(
      expect.objectContaining({ event: "doh.retry", code: "ECONNRESET" }),
    );
  });
  it.each([
    { status: 429, body: good },
    { status: 503, body: good },
    { status: 200, body: "broken" },
    { status: 200, body: "{}" },
    { status: 200, body: "x".repeat(65537) },
  ])("does not retry HTTP or malformed contracts: $status", async (outcome) => {
    const { spy } = network([outcome]);
    await expect(queryDoh("api.jup.ag", 1)).rejects.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("bounds two hung attempts to two seconds total and destroys both requests", async () => {
    vi.useFakeTimers();
    const { spy, requests } = network(["HANG"]);
    const rejected = expect(queryDoh("api.jup.ag", 1)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(spy).toHaveBeenCalledTimes(2);
    expect(requests.every((r) => r.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never starts DNS for an already cancelled request", async () => {
    const { spy } = network(["HANG"]);
    await expect(
      queryDoh("api.jup.ag", 1, "cloudflare", () => {}, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spy).not.toHaveBeenCalled();
  });
});
