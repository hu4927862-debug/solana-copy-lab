import {describe,it,expect,vi} from "vitest";
import {createIsolatedJupiterFetch} from "../../src/network/isolated-jupiter-fetch.js";
import {JupiterOrderAdapter} from "../../src/execution/jupiter-order-adapter.js";
import {JupiterRequestPacer} from "../../src/network/jupiter-request-pacer.js";

describe("account-wide Jupiter Free pacing",()=>{
 it("rejects overlapping first/sidecar/recovery quotes across transport instances before HTTP",async()=>{
  vi.useFakeTimers();vi.stubEnv("V6_JUPITER_ACCOUNT_PACING","JUPITER_FREE_2S_V1");
  const http=vi.fn(async()=>new Response("{}",{status:200}));vi.stubGlobal("fetch",http);
  const a=createIsolatedJupiterFetch(),b=createIsolatedJupiterFetch();
  try{
   await vi.advanceTimersByTimeAsync(2000);
   const request={inputMint:"SOL_NATIVE",outputMint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",amount:1n};
   const aborted=new AbortController();aborted.abort();
   await expect(new JupiterOrderAdapter("DUMMY",a).getOrder({...request,signal:aborted.signal})).rejects.toThrow();
   expect(http).not.toHaveBeenCalled();
   // Schema is intentionally irrelevant: even unsuccessful HTTP consumes account capacity.
   await Promise.allSettled([new JupiterOrderAdapter("DUMMY",a).getOrder(request),new JupiterOrderAdapter("DUMMY",b).getOrder(request),new JupiterOrderAdapter("DUMMY",a).getOrder(request)]);
   expect(http).toHaveBeenCalledTimes(1);
  }finally{await a.close();await b.close();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();}
 });
 it("has no startup credit and waits two seconds after actual settlement, not dispatch",()=>{
  let now=0;const p=new JupiterRequestPacer(()=>now);
  expect(()=>p.acquire()).toThrow("JUPITER_LOCAL_RATE_LIMIT");
  now=2000;const release=p.acquire();
  now=12000;expect(()=>p.acquire()).toThrow("JUPITER_LOCAL_RATE_LIMIT");
  release();now=13999;expect(()=>p.acquire()).toThrow("JUPITER_LOCAL_RATE_LIMIT");
  now=14000;const next=p.acquire();release(); // stale double-release cannot unlock active successor
  expect(()=>p.acquire()).toThrow("JUPITER_LOCAL_RATE_LIMIT");next();
 });
 it("allows at most one of simultaneous first quote, delayed quote, recovery and reconnect callers",()=>{
  let now=2000;const p=new JupiterRequestPacer(()=>now);now=4000;
  const outcomes=["first","delayed+3","delayed+10","recovery","reconnect"].map(()=>{try{return p.acquire();}catch{return undefined;}});
  expect(outcomes.filter(Boolean)).toHaveLength(1);outcomes[0]!();
  now=5999;expect(()=>p.acquire()).toThrow();now=6000;expect(()=>p.acquire()).not.toThrow();
 });
 it("rejects unknown pacing versions without networking",()=>{
  vi.stubEnv("V6_JUPITER_ACCOUNT_PACING","UNKNOWN");
  try{expect(()=>createIsolatedJupiterFetch()).toThrow("UNKNOWN_JUPITER_ACCOUNT_PACING");}finally{vi.unstubAllEnvs();}
 });
});
