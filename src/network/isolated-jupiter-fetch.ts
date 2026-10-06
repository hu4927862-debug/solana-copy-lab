import { Agent } from "undici";
import { configuredJupiterPacer } from "./jupiter-request-pacer.js";
import {
  createIsolatedResolver,
  safeNetworkCode,
  type ResolverAudit,
} from "./v6-isolated-dns.js";

export interface IsolatedJupiterFetchOptions {
  readonly resolver?: ReturnType<typeof createIsolatedResolver>;
  readonly audit?: ResolverAudit;
}
export type IsolatedJupiterFetch = typeof fetch & { close(): Promise<void>; pendingCount(): number };

/** Quote-scoped connections make DNS, TCP, TLS and body cancellation independent. */
export function createIsolatedJupiterFetch(
  options: IsolatedJupiterFetchOptions = {},
): IsolatedJupiterFetch {
  const emit: ResolverAudit = (record) => {
    try {
      options.audit?.(record);
    } catch {
      /* Observer isolation. */
    }
  };
  const resolver = options.resolver ?? createIsolatedResolver({ audit: emit });
  const pacer = configuredJupiterPacer();
  const active = new Map<Agent, AbortController>();
  let sequence = 0;
  let closed = false;
  const fetcher: typeof fetch = async (input, init) => {
    if (closed) throw new Error("JUPITER_FETCH_CLOSED");
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      url.origin !== "https://api.jup.ag" ||
      url.pathname !== "/swap/v2/order" ||
      method !== "GET" ||
      url.searchParams.has("taker")
    )
      throw new Error("JUPITER_QUOTE_BOUNDARY");
    const caller =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    caller?.throwIfAborted();
    let releasePacing: (() => void) | undefined;
    try {
      releasePacing = pacer?.acquire();
    } catch (error) {
      emit({ event: "jupiter.rate_limit.rejected", reason: "JUPITER_LOCAL_RATE_LIMIT" });
      throw error; // no HTTP, no queue, no synthetic 429 and no provider retry
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(3000),
      ...(caller ? [caller] : []),
    ]);
    const requestId = ++sequence;
    const started = performance.now();
    const lookup = resolver.lookupFor(signal);
    const agent = new Agent({
      connect: {
        rejectUnauthorized: true,
        lookup: (host, options, callback) => {
          emit({ event: "jupiter.dns.start", requestId, host });
          lookup(host, options, (error, address, family) => {
            emit({
              event: "jupiter.dns.complete",
              requestId,
              host,
              ...(error
                ? { code: safeNetworkCode(error) }
                : { addresses: address }),
              durationMs: performance.now() - started,
            });
            callback(error, address, family);
          });
        },
      },
    });
    active.set(agent, controller);
    const abort = () => {
      emit({
        event: "jupiter.transport.cancelled",
        requestId,
        code: safeNetworkCode(signal.reason),
        durationMs: performance.now() - started,
      });
      void agent.destroy().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    emit({ event: "jupiter.transport.start", requestId });
    try {
      const response = await fetch(input, {
        ...init,
        signal,
        redirect: "error",
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent });
      emit({
        event: "jupiter.http.headers",
        requestId,
        httpStatus: response.status,
        durationMs: performance.now() - started,
      });
      return response;
    } catch (error) {
      emit({
        event: "jupiter.transport.error",
        requestId,
        code: safeNetworkCode(error),
        durationMs: performance.now() - started,
      });
      await agent.destroy();
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      // close waits for the response body; keep cancellation attached until then.
      void agent
        .close()
        .catch(() => {})
        .finally(() => {
          signal.removeEventListener("abort", abort);
          active.delete(agent);
          releasePacing?.();
        });
    }
  };
  return Object.assign(fetcher, {
    pendingCount: () => active.size,
    async close() {
      closed = true;
      const agents = [...active];
      for (const [, controller] of agents) controller.abort();
      await Promise.all(agents.map(([agent]) => agent.destroy()));
      await Promise.all(agents.map(([agent]) => agent.close().catch(()=>{})));
      for(const [agent] of agents)active.delete(agent);
    },
  });
}
