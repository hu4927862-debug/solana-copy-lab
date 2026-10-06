// Production Jupiter DNS isolation. No OS DNS, stale fallback, or host configuration changes.
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { z } from "zod";

export const dohProviders = {
  cloudflare: {
    hostname: "cloudflare-dns.com",
    address: "1.1.1.1",
    path: "/dns-query",
  },
  google: { hostname: "dns.google", address: "8.8.8.8", path: "/resolve" },
} as const;
type Audit = (record: Record<string, unknown>) => void;
const responseSchema = z.object({
  Status: z.literal(0),
  TC: z.literal(false),
  Question: z.array(z.object({ name: z.string(), type: z.number() })).length(1),
  Answer: z
    .array(
      z.object({
        name: z.string(),
        type: z.number(),
        TTL: z.number().int().nonnegative(),
        data: z.string(),
      }),
    )
    .default([]),
});
const name = (value: string) => value.toLowerCase().replace(/\.$/, "");
const failure = (code: string) =>
  Object.assign(new Error(code), { code: "ENOTFOUND" });

export const DNS_TOTAL_BUDGET_MS = 2000;
export const DNS_ATTEMPT_TIMEOUT_MS = 1000;
const transientCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
export function safeNetworkCode(error: unknown, depth = 0): string {
  if (error instanceof Error && depth < 5) {
    if (error.name === "AbortError") return "ABORTED";
    if (error.name === "TimeoutError") return "TIMEOUT";
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code &&
      (transientCodes.has(code) ||
        /^(?:ENOTFOUND|EAI_AGAIN|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_SSL_SSL\/TLS_ALERT_HANDSHAKE_FAILURE)$/.test(
          code,
        ))
    )
      return code;
    if (error.cause) return safeNetworkCode(error.cause, depth + 1);
  }
  return "OTHER_NETWORK_OR_CONTRACT_ERROR";
}
export type ResolverAudit = (record: Record<string, unknown>) => void;

// Literal bootstrap addresses avoid OS DNS; verified TLS keeps the hostname binding.
export async function queryDoh(
  host: string,
  type: number,
  provider: keyof typeof dohProviders = "cloudflare",
  audit: Audit = () => {},
  signal?: AbortSignal,
  maxAttempts: 1 | 2 = 2,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (host !== "api.jup.ag" || ![1, 28].includes(type))
    throw failure("HOST_NOT_ALLOWED");
  const target = dohProviders[provider];
  const started = performance.now();
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      audit({
        event,
        provider,
        host,
        type,
        durationMs: performance.now() - started,
        ...fields,
      });
    } catch {
      /* Observer isolation. */
    }
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    const remaining = DNS_TOTAL_BUDGET_MS - (performance.now() - started);
    if (remaining <= 0)
      throw Object.assign(new Error("DOH_BUDGET_EXHAUSTED"), {
        code: "ETIMEDOUT",
      });
    try {
      emit("doh.start", { attempt, bootstrapAddress: target.address });
      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (error?: unknown, value?: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (error !== undefined) {
            req.destroy();
            reject(error);
          } else resolve(value);
        };
        const abort = () => finish(signal!.reason);
        const req = https.request(
          {
            hostname: target.hostname,
            servername: target.hostname,
            port: 443,
            path: `${target.path}?name=${host}&type=${type}`,
            method: "GET",
            headers: { accept: "application/dns-json" },
            agent: false,
            rejectUnauthorized: true,
            lookup: (_hostname, options, callback) =>
              options.all
                ? callback(null, [{ address: target.address, family: 4 }])
                : callback(null, target.address, 4),
          },
          (response) => {
            response.on("error", (error: unknown) => finish(error));
            if (response.statusCode !== 200) {
              finish(failure("DOH_HTTP_ERROR"));
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > 65536) finish(failure("DOH_BODY_TOO_LARGE"));
              else chunks.push(chunk);
            });
            response.on("end", () => {
              if (settled) return;
              try {
                const body = responseSchema.parse(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")),
                );
                if (
                  name(body.Question[0]!.name) !== host ||
                  body.Question[0]!.type !== type
                )
                  throw failure("DOH_QUESTION_MISMATCH");
                emit("doh.answer", {
                  attempt,
                  httpStatus: 200,
                  bootstrapAddress: target.address,
                });
                finish(undefined, body);
              } catch (error) {
                finish(error);
              }
            });
          },
        );
        req.on("error", (error: unknown) => finish(error));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        timer = setTimeout(
          () =>
            finish(
              Object.assign(new Error("DOH_TIMEOUT"), { code: "ETIMEDOUT" }),
            ),
          Math.min(DNS_ATTEMPT_TIMEOUT_MS, remaining),
        );
        req.end();
      });
    } catch (error) {
      const code = safeNetworkCode(error);
      const retry =
        !signal?.aborted &&
        attempt < maxAttempts &&
        transientCodes.has(code) &&
        performance.now() - started < DNS_TOTAL_BUDGET_MS;
      emit(
        retry ? "doh.retry" : signal?.aborted ? "doh.cancelled" : "doh.error",
        { attempt, code },
      );
      if (!retry) throw error;
    }
  }
  throw failure("DOH_RETRY_EXHAUSTED");
}

export function createIsolatedResolver(
  options: {
    query?: (
      host: string,
      type: number,
      signal: AbortSignal,
    ) => Promise<unknown>;
    now?: () => number;
    audit?: Audit;
  } = {},
) {
  const audit = options.audit ?? (() => {});
  const query =
    options.query ??
    ((host, type, signal) => queryDoh(host, type, "cloudflare", audit, signal));
  const now = options.now ?? (() => performance.now());
  type Addresses = { address: string; family: number }[];
  type Job = {
    controller: AbortController;
    users: number;
    done: boolean;
    promise: Promise<Addresses>;
  };
  let cached: { addresses: Addresses; expiresAt: number } | undefined;
  let pending: Job | undefined;
  const emit = (record: Record<string, unknown>) => {
    try {
      audit(record);
    } catch {
      /* Observer isolation. */
    }
  };
  async function resolve(
    host: string,
    signal?: AbortSignal,
  ): Promise<Addresses> {
    signal?.throwIfAborted();
    if (host !== "api.jup.ag") throw failure("HOST_NOT_ALLOWED");
    if (cached && now() < cached.expiresAt) {
      emit({
        event: "isolated.resolve",
        host,
        cache: true,
        addresses: cached.addresses,
      });
      return cached.addresses.map((entry) => ({ ...entry }));
    }
    if (!pending) {
      cached = undefined;
      const controller = new AbortController();
      const job: Job = {
        controller,
        users: 0,
        done: false,
        promise: Promise.resolve([]),
      };
      pending = job;
      job.promise = (async () => {
        const started = now();
        try {
          const results = await Promise.allSettled(
            [1, 28].map(async (type) => ({
              type,
              body: responseSchema.parse(
                await query(host, type, controller.signal),
              ),
            })),
          );
          controller.signal.throwIfAborted();
          const addresses: Addresses = [];
          let ttl = 60;
          let siblingTimeout: unknown;
          for (const result of results) {
            if (result.status === "rejected") {
              // A and AAAA are independent address families. A bounded timeout
              // in one does not invalidate authenticated, fully checked fresh
              // addresses from the other. No second DNS request or stale answer
              // is introduced; all other failures remain fatal.
              if (safeNetworkCode(result.reason) !== "ETIMEDOUT") throw result.reason;
              siblingTimeout ??= result.reason;
              continue;
            }
            const { type, body } = result.value;
            if (
              name(body.Question[0]!.name) !== host ||
              body.Question[0]!.type !== type
            )
              throw failure("DOH_QUESTION_MISMATCH");
            let owner = host;
            const visited = new Set<string>();
            while (true) {
              if (visited.has(owner)) throw failure("DOH_CNAME_LOOP");
              visited.add(owner);
              const aliases = body.Answer.filter(
                (rr) => rr.type === 5 && name(rr.name) === owner,
              );
              if (!aliases.length) break;
              if (aliases.length !== 1) throw failure("DOH_CNAME_AMBIGUOUS");
              ttl = Math.min(ttl, aliases[0]!.TTL);
              owner = name(aliases[0]!.data);
            }
            for (const rr of body.Answer.filter(
              (rr) => rr.type === type && name(rr.name) === owner,
            )) {
              const family = type === 1 ? 4 : 6;
              if (isIP(rr.data) !== family)
                throw failure("DOH_INVALID_ADDRESS");
              ttl = Math.min(ttl, rr.TTL);
              addresses.push({ address: rr.data, family });
            }
          }
          if (!addresses.length) throw siblingTimeout ?? failure("DOH_NO_BOUND_ADDRESSES");
          cached = { addresses, expiresAt: started + ttl * 1000 };
          emit({
            event: "isolated.resolve",
            host,
            cache: false,
            addresses,
            ttlSeconds: ttl,
          });
          return addresses;
        } catch (error) {
          controller.abort(error); // Stop a still-running A/AAAA sibling.
          throw error;
        } finally {
          job.done = true;
          if (pending === job) pending = undefined;
        }
      })();
    }
    const job = pending;
    job.users++;
    return new Promise<Addresses>((resolveWaiter, rejectWaiter) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        job.users--;
        if (!job.done && job.users === 0) {
          if (pending === job) pending = undefined;
          job.controller.abort();
          emit({ event: "isolated.cancelled", host });
        }
        return true;
      };
      const abort = () => {
        if (release()) rejectWaiter(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      job.promise.then(
        (addresses) => {
          if (release())
            resolveWaiter(addresses.map((entry) => ({ ...entry })));
        },
        (error: unknown) => {
          if (release()) rejectWaiter(error);
        },
      );
    });
  }
  function lookupFor(signal?: AbortSignal): LookupFunction {
    return (host, opts, callback) => {
      void resolve(host, signal).then(
        (addresses) => {
          const family =
            opts.family === "IPv4"
              ? 4
              : opts.family === "IPv6"
                ? 6
                : opts.family;
          const selected = family
            ? addresses.filter((entry) => entry.family === family)
            : addresses;
          if (!selected.length) {
            callback(failure("DOH_NO_REQUESTED_FAMILY"), "", 0);
            return;
          }
          if (opts.all) callback(null, selected);
          else callback(null, selected[0]!.address, selected[0]!.family);
        },
        (error: Error) => callback(error, "", 0),
      );
    };
  }
  return { resolve, lookupFor, lookup: lookupFor() };
}
