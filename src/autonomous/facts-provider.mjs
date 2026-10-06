// Read-only refresh over the existing Research request ledger and Manual RPC
// transport. No signer, send, stage reset, provider fallback or automatic retry.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  decodeWire,
  verifyExternalSignature,
} from "../live/transaction-review.ts";
import { JupiterManagedNetwork } from "../live/adapters.ts";
import { inspectAutonomousRuntime } from "./journal-runtime.ts";
import { readCapitalSettlement } from "./capital-controls.ts";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOL = "So11111111111111111111111111111111111111112",
  USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const need = (v, c) => {
  if (!v) throw Error(c);
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (x) =>
  x && typeof x === "object"
    ? Array.isArray(x)
      ? x.map(canonical)
      : Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
    : x;
const json = (x) => JSON.stringify(canonical(x));
const raw = (x) => typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x);
const uint = (x) => Number.isSafeInteger(x) && x >= 0;
function safeFailureDetails(details, providerOptions) {
  if (!details || typeof details !== "object") return {};
  const result = {};
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599)
    result.http_status = details.httpStatus;
  if (typeof details.bodySha256 === "string" && /^[a-f0-9]{64}$/.test(details.bodySha256))
    result.body_sha256 = details.bodySha256;
  if (uint(details.bodyBytes)) result.body_bytes = details.bodyBytes;
  if (details.jsonRpcError && typeof details.jsonRpcError === "object") {
    const e = details.jsonRpcError;
    let message = typeof e.message === "string" ? e.message : null;
    if (message !== null) {
      for (const secret of [providerOptions.rpcUrl, providerOptions.quoteKey].filter(Boolean))
        message = message.replaceAll(secret, "<REDACTED>");
      message = message.replace(/https?:\/\/[^\s"']+/g, "<URL_REDACTED>")
        .replace(/(?:api[-_]?key|authorization|token)\s*[:=]\s*[^\s,;"']+/gi, "<CREDENTIAL_REDACTED>")
        .slice(0, 1024);
    }
    const dataContext = {};
    for (const key of ["contextSlot", "slot", "minContextSlot", "blockHeight", "lastValidBlockHeight", "numSlotsBehind"])
      if (uint(e.dataContext?.[key])) dataContext[key] = e.dataContext[key];
    result.json_rpc_error = {
      code: Number.isSafeInteger(e.code) ? e.code : null,
      message,
      dataContext,
    };
  }
  return result;
}
function pinned(ref) {
  need(
    ref && path.isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256),
    "FACT_REFERENCE_REQUIRED",
  );
  const s = fs.lstatSync(ref.path);
  need(
    s.isFile() && !s.isSymbolicLink() && fs.realpathSync(ref.path) === ref.path,
    "FACT_REFERENCE_TYPE",
  );
  const b = fs.readFileSync(ref.path);
  need(hash(b) === ref.sha256, "FACT_REFERENCE_CHANGED");
  return JSON.parse(b);
}
function writeEvidence(directory, name, record) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const b = JSON.stringify(record, null, 2) + "\n",
    file = path.join(directory, name + "-" + hash(b) + ".json");
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, b);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const d = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } else need(hash(fs.readFileSync(file)) === hash(b), "FACT_OUTPUT_CHANGED");
  return { ...record, evidence: { path: path.resolve(file), sha256: hash(b) } };
}
function readonly(file, fn) {
  need(
    fs.existsSync(file) &&
      fs.lstatSync(file).isFile() &&
      !fs.lstatSync(file).isSymbolicLink(),
    "FACT_JOURNAL_MISSING",
  );
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only=ON");
    db.exec("BEGIN");
    return fn(db);
  } finally {
    db.close();
  }
}

/** Only bound LiveJournal finalized settlements, never Research virtual fills.
 * Daily net is CLOSED episode wallet cashflow (fees/rent already included),
 * attributed at final closure blockTime. Open episodes remain an explicit cost
 * unknown; this is not an estimate of mark-to-market or future exit value. */
export function readFinalizedRuntimeAccounting({
  runtimeDirectory,
  identity,
  nowMs,
}) {
  const index = path.join(runtimeDirectory, "runtime.sqlite"),
    utcDay = new Date(nowMs).toISOString().slice(0, 10);
  return readonly(index, (db) => {
    const meta = Object.fromEntries(
      db
        .prepare("SELECT k,v FROM runtime_meta")
        .all()
        .map((r) => [r.k, r.v]),
    );
    need(
      json(JSON.parse(meta.identity)) === json(identity),
      "FACT_RUNTIME_IDENTITY",
    );
    const episodes = db
        .prepare("SELECT * FROM runtime_episodes ORDER BY id")
        .all(),
      settlements = [],
      unknownCosts = [],
      unknownCostBreakdown = [];
    let daily = 0n;
    for (const row of episodes) {
      const d = JSON.parse(row.descriptor);
      need(
        d.wallet === identity.wallet &&
          hash(JSON.stringify(d, Object.keys(d).sort())) ===
            row.descriptor_digest,
        "FACT_EPISODE_BINDING",
      );
      const file = path.join(
        runtimeDirectory,
        "episodes",
        hash(d.episodeId),
        "live.sqlite",
      );
      readonly(file, (j) => {
        const m = Object.fromEntries(
          j
            .prepare("SELECT key,value FROM live_meta")
            .all()
            .map((r) => [r.key, r.value]),
        );
        need(m.protocol === d.protocolDigest, "FACT_JOURNAL_PROTOCOL");
        const attempts = j
            .prepare("SELECT * FROM live_attempts")
            .all()
            .map((a) => ({ ...a, data: JSON.parse(a.data) })),
          rows = j.prepare("SELECT * FROM live_settlements").all();
        let cash = 0n,
          position = 0n,
          closingMs = 0;
        for (const r of rows) {
          const a = attempts.find((a) => a.id === r.attempt_id),
            e = JSON.parse(r.evidence);
          need(
            a &&
              a.data.signature === r.signature &&
              json(a.data.settlement) === json(e) &&
              ["SETTLED", "CHAIN_FAILED"].includes(a.state) &&
              e.commitment === "finalized" &&
              /^-?\d+$/.test(e.walletDeltaRaw) &&
              /^-?\d+$/.test(e.tokenDeltaRaw),
            "FACT_SETTLEMENT_BINDING",
          );
          const tx = e.rawFinalizedTransaction,
            blockMs = Number(tx?.blockTime) * 1000;
          need(
            uint(blockMs) &&
              blockMs > 0 &&
              uint(tx?.slot) &&
              Array.isArray(tx.transaction) &&
              tx.transaction[1] === "base64" &&
              tx.transaction[0] === a.data.signedTransaction &&
              typeof a.data.unsignedTransaction === "string",
            "FACT_SETTLEMENT_TIME_OR_SIGNATURE",
          );
          const verified = verifyExternalSignature(
            a.data.unsignedTransaction,
            a.data.signedTransaction,
            identity.wallet,
          );
          need(verified.signature === r.signature, "FACT_SETTLEMENT_SIGNATURE");
          cash += BigInt(e.walletDeltaRaw);
          position += BigInt(e.tokenDeltaRaw);
          closingMs = Math.max(closingMs, blockMs);
          if (e.unknownCosts?.length)
            unknownCostBreakdown.push(...e.unknownCosts);
          settlements.push({
            signature: r.signature,
            protocolDigest: d.protocolDigest,
            walletDeltaRaw: e.walletDeltaRaw,
            tokenDeltaRaw: e.tokenDeltaRaw,
            slot: tx.slot,
            blockTimeMs: blockMs,
            rawFinalizedTransaction: tx,
          });
        }
        const terminal = [
          "SETTLED",
          "CHAIN_FAILED",
          "UNSIGNED_CANCELLED",
          "ABANDONED_EXPIRED_UNSIGNED",
          "ABANDONED_EXPIRED_SIGNED_UNSENT",
        ];
        let auditedUnpreparedClosure = false;
        if (row.state === "ABANDONED_UNPREPARED") {
          const receipt = JSON.parse(
            meta["unpreparedClosure:" + d.episodeId] ?? "null",
          );
          const journalDigest = hash(
            JSON.stringify([
              j.prepare("SELECT * FROM live_meta ORDER BY key").all(),
              j.prepare("SELECT * FROM live_attempts ORDER BY id").all(),
              j.prepare("SELECT * FROM live_events ORDER BY sequence").all(),
              j
                .prepare("SELECT * FROM live_settlements ORDER BY signature")
                .all(),
            ]),
          );
          need(
            receipt?.schema === "AUTONOMOUS_UNPREPARED_EPISODE_CLOSURE_V1" &&
              receipt.state === row.state &&
              json(receipt.descriptor) === json(d) &&
              receipt.journalDigest === journalDigest &&
              receipt.fundsMoved === 0 &&
              receipt.noNewEntry === true &&
              receipt.capitalReceipt &&
              attempts.length === 0 &&
              rows.length === 0 &&
              m.requestCount === "0" &&
              !m.takeover &&
              !m.entryStopped &&
              !m.exitAuthority &&
              j.prepare("SELECT COUNT(*) n FROM live_events").get().n === 0,
            "FACT_UNPREPARED_CLOSURE_EVIDENCE",
          );
          auditedUnpreparedClosure = true;
        }
        const closed =
          (attempts.length > 0 || auditedUnpreparedClosure) &&
          position === 0n &&
          !m.takeover &&
          attempts.every(
            (a) =>
              terminal.includes(a.state) &&
              (!["SETTLED", "CHAIN_FAILED"].includes(a.state) ||
                a.data.balanceReconciled === true),
          );
        if (!closed) unknownCosts.push("EXISTING_EPISODE_NOT_CLOSED");
        else if (
          closingMs &&
          new Date(closingMs).toISOString().slice(0, 10) === utcDay
        )
          daily += cash;
      });
    }
    return {
      wallet: identity.wallet,
      utcDay,
      dailyRealizedNetLamports: daily.toString(),
      unknownCosts: [...new Set(unknownCosts)],
      unknownCostBreakdown: [...new Set(unknownCostBreakdown)],
      finalizedOnly: true,
      metric: "FINALIZED_CLOSED_EPISODE_WALLET_CASHFLOW_INCLUDING_RENT",
      settlements,
    };
  });
}
class WalletFactsNetwork extends JupiterManagedNetwork {
  constructor(rpcUrl, audit) {
    super(rpcUrl, false, undefined, () => {}, audit);
  }
  async read(method, params) {
    need(
      ["getAccountInfo", "getTokenAccountsByOwner"].includes(method),
      "FACT_READ_METHOD_DENIED",
    );
    return this.rpc(method, params);
  }
}
function tokens(response, wallet, program, minSlot) {
  need(
    uint(Number(response?.context?.slot)) &&
      Number(response.context.slot) >= minSlot &&
      Array.isArray(response.value),
    "FACT_TOKEN_CONTEXT",
  );
  return response.value
    .map((row) => {
      const a = row.account,
        i = a?.data?.parsed?.info;
      need(
        a?.owner === program &&
          a.executable === false &&
          a.data?.parsed?.type === "account" &&
          i?.owner === wallet &&
          raw(i.tokenAmount?.amount) &&
          uint(i.tokenAmount?.decimals) &&
          i.state === "initialized" &&
          !i.delegate &&
          !i.closeAuthority &&
          !i.isNative,
        "FACT_TOKEN_ACCOUNT_CONTRACT",
      );
      return {
        address: row.pubkey,
        mint: i.mint,
        program,
        raw: i.tokenAmount.amount,
        decimals: i.tokenAmount.decimals,
        lamports: String(a.lamports),
      };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
}
function expectedAccounts(anchor, settlements, wallet) {
  let balance = BigInt(anchor.balanceLamports);
  const map = new Map(anchor.tokens.map((x) => [x.address, x]));
  for (const s of [...settlements]
    .filter((s) => s.slot > anchor.slot)
    .sort((a, b) => a.slot - b.slot)) {
    balance += BigInt(s.walletDeltaRaw);
    const t = s.rawFinalizedTransaction,
      keys = [...decodeWire(t.transaction[0]).message.staticAccounts];
    keys.push(
      ...(t.meta.loadedAddresses?.writable ?? []),
      ...(t.meta.loadedAddresses?.readonly ?? []),
    );
    const post = new Map(
      (t.meta.postTokenBalances ?? [])
        .filter((x) => x.owner === wallet)
        .map((x) => [x.accountIndex, x]),
    );
    for (const x of (t.meta.preTokenBalances ?? []).filter(
      (x) => x.owner === wallet,
    ))
      if (!post.has(x.accountIndex)) {
        need(
          String(t.meta.postBalances[x.accountIndex]) === "0",
          "FACT_FINALIZED_TOKEN_CLOSE_AMBIGUOUS",
        );
        map.delete(keys[x.accountIndex]);
      }
    for (const [idx, x] of post) {
      need(
        x.programId === TOKEN || x.programId === TOKEN2022,
        "FACT_FINALIZED_TOKEN_PROGRAM_UNKNOWN",
      );
      map.set(keys[idx], {
        address: keys[idx],
        mint: x.mint,
        program: x.programId,
        raw: x.uiTokenAmount.amount,
        decimals: x.uiTokenAmount.decimals,
        lamports: String(t.meta.postBalances[idx]),
      });
    }
  }
  return {
    balanceLamports: balance.toString(),
    tokens: [...map.values()].sort((a, b) =>
      a.address.localeCompare(b.address),
    ),
  };
}

/** A reviewed opening may continue a canonical CLOSED ledger. This is a
 * read-only provenance check, not new authority, accounting or a state reset. */
export function createFinalizedClosedOpening(input) {
  const {runtimeDirectory,identity,outcomeReference,priorOpeningReference,stageDatabase,sourceStageWallet,claimDirectory}=input;
  need(identity?.wallet && [runtimeDirectory,stageDatabase,claimDirectory].every(p=>typeof p==='string'&&path.isAbsolute(p)), 'CONTINUATION_PATH_BINDING');
  const runtime=inspectAutonomousRuntime(runtimeDirectory),outcome=pinned(outcomeReference),prior=pinned(priorOpeningReference);
  need(runtime.state==='INITIALIZED'&&json(runtime.identity)===json(identity)&&!runtime.active&&
    outcome.schema==='FINALIZED_FOLLOWER_OUTCOME_V1'&&outcome.roundtripCompleted===true&&outcome.positionRaw==='0'&&
    prior.schema==='AUTONOMOUS_REVIEWED_OPENING_ANCHOR_V1'&&prior.wallet===identity.wallet,
    'CONTINUATION_FINALIZED_CLOSED_REQUIRED');
  const episodeDirectory=path.join(runtimeDirectory,'episodes',hash(outcome.episodeId));
  need(outcomeReference.path===path.join(episodeDirectory,'outcome.json'),'CONTINUATION_CANONICAL_OUTCOME_PATH');
  const descriptor=readonly(path.join(runtimeDirectory,'runtime.sqlite'),db=>{
    const row=db.prepare('SELECT * FROM runtime_episodes WHERE id=?').get(outcome.episodeId);
    need(row?.state==='CLOSED','CONTINUATION_EPISODE_NOT_CLOSED');return JSON.parse(row.descriptor);
  });
  need(descriptor.wallet===identity.wallet&&descriptor.protocolDigest===outcome.protocolDigest&&descriptor.mint===outcome.mint,'CONTINUATION_OUTCOME_IDENTITY');
  const stage=readonly(stageDatabase,db=>Object.fromEntries(db.prepare("SELECT k,v FROM kv WHERE k IN ('humanFollow:v1','autonomousCapital:v1')").all().map(r=>[r.k,JSON.parse(r.v)])));
  const h=stage['humanFollow:v1'],b=stage['autonomousCapital:v1'],closed=b?.outcomes?.[outcome.episodeId];
  need(h?.wallet===sourceStageWallet&&!h.obligation&&!h.actualReviewRequired&&!b?.active&&
    [identity.wallet,sourceStageWallet].every(w=>!fs.existsSync(path.join(claimDirectory,w+'.json'))), 'CONTINUATION_RESPONSIBILITY_REMAINS');
  const reservation=closed?.reservation;
  need(closed?.kind==='FINALIZED_JOURNAL_CLOSED'&&closed.roundtripCompleted===true&&
    reservation?.journalPath===path.join(episodeDirectory,'live.sqlite')&&reservation.protocolDigest===outcome.protocolDigest&&
    reservation.identity.wallet===identity.wallet&&reservation.identity.releaseDigest===identity.releaseDigest&&reservation.identity.policyDigest===identity.policyDigest,
    'CONTINUATION_CAPITAL_CLOSURE_BINDING');
  const evidence=readCapitalSettlement(reservation,false);
  need(evidence.digest===closed.journalEvidenceDigest&&closed.netCashflowRaw===outcome.walletNetCashflowLamports,'CONTINUATION_JOURNAL_CLOSURE_CHANGED');
  const accounting=readFinalizedRuntimeAccounting({runtimeDirectory,identity,nowMs:Date.now()});
  need(!accounting.unknownCosts.length,'CONTINUATION_ACCOUNTING_UNRESOLVED');
  const attempts=readonly(reservation.journalPath,db=>db.prepare('SELECT * FROM live_attempts ORDER BY id').all().map(a=>({...a,data:JSON.parse(a.data)})));
  need(json(outcome.settlements)===json(attempts.filter(a=>a.data.settlement).map(a=>({id:a.id,side:a.side,signature:a.data.signature,evidence:a.data.settlement}))), 'CONTINUATION_OUTCOME_SETTLEMENT_CHANGED');
  const final=outcome.settlements.at(-1),settlement=final?.evidence;
  need(final?.side==='SELL'&&settlement?.commitment==='finalized'&&!settlement.failed&&settlement.violations?.length===0&&
    hash(JSON.stringify(settlement.rawFinalizedTransaction))===settlement.chainEvidenceDigest&&
    accounting.settlements.every(s=>s.slot<=Number(settlement.slot)), 'CONTINUATION_LATEST_FINALIZED_SELL_REQUIRED');
  const expected=expectedAccounts(prior,accounting.settlements,identity.wallet);
  need(expected.balanceLamports===settlement.walletPostRaw&&expected.tokens.every(t=>t.raw==='0'&&t.mint!==SOL&&t.program===TOKEN), 'CONTINUATION_NONZERO_OR_UNPROVEN_ASSET');
  const snapshot=attempts.find(a=>a.id===final.id)?.data.balanceSnapshot;
  need(snapshot?.wsolAbsent===true&&snapshot.tokenRaw==='0'&&snapshot.walletLamports===expected.balanceLamports,'CONTINUATION_FINALIZED_BALANCE_REQUIRED');
  // Preserve the old stage basis and each capital outcome; later CLOSED entries
  // may append costs, never reset the prior loss/carry or delete a receipt.
  const basis=input.stageBasis??{scope:hash(json(h.scope)),carry:hash(json(h.carry)),spentMicroCny:h.spentMicroCny,outcomes:Object.fromEntries(Object.entries(b.outcomes).map(([k,v])=>[k,hash(json(v))]))};
  need(basis.scope===hash(json(h.scope))&&basis.carry===hash(json(h.carry))&&uint(basis.spentMicroCny)&&
    Object.entries(basis.outcomes).every(([k,v])=>b.outcomes[k]&&hash(json(b.outcomes[k]))===v)&&
    h.spentMicroCny===basis.spentMicroCny+Object.entries(b.outcomes).filter(([k])=>!Object.hasOwn(basis.outcomes,k)).reduce((n,[,v])=>{need(uint(v.lossMicroCny),'CONTINUATION_STAGE_COST');return n+v.lossMicroCny;},0), 'CONTINUATION_STAGE_CONTINUITY');
  // Optional explicitly pinned funding proof, never a transfer capability.
  // Only one direct external SOL deposit of the exact existing minimum gap is
  // accepted. Maintenance, arbitrary credits and unexplained history still stop.
  let balanceLamports=expected.balanceLamports;
  if(input.funding){
    const f=input.funding,request=pinned(f.requestReference),response=pinned(f.responseReference),tx=response.result;
    const amount=18200000n-BigInt(balanceLamports),keys=tx?.transaction?.message?.accountKeys;
    need(request.method==='getTransaction'&&request.params?.[0]===f.signature&&request.params[1]?.commitment==='finalized'&&request.params[1]?.encoding==='jsonParsed'&&
      response.id===request.id&&!response.error&&tx?.meta?.err===null&&uint(tx.slot)&&tx.slot>Number(settlement.slot)&&
      tx.transaction.signatures?.[0]===f.signature&&Array.isArray(keys)&&keys.every(k=>typeof k.pubkey==='string'&&typeof k.signer==='boolean')&&
      keys.filter(k=>k.signer).length===1&&keys[0].signer&&keys[0].pubkey===f.source&&f.source!==identity.wallet&&
      amount>0n&&!(tx.meta.innerInstructions??[]).length&&!(tx.meta.preTokenBalances??[]).length&&!(tx.meta.postTokenBalances??[]).length,
      'CONTINUATION_FUNDING_PROOF_REQUIRED');
    const instructions=tx.transaction.message.instructions,transfers=instructions.filter(i=>i.programId==='11111111111111111111111111111111');
    need(transfers.length===1&&transfers[0].parsed?.type==='transfer'&&transfers[0].parsed.info.source===f.source&&transfers[0].parsed.info.destination===identity.wallet&&
      uint(transfers[0].parsed.info.lamports)&&BigInt(transfers[0].parsed.info.lamports)===amount&&
      instructions.every(i=>i===transfers[0]||i.programId==='ComputeBudget111111111111111111111111111111'), 'CONTINUATION_FUNDING_NOT_EXACT_TOPUP');
    const idx=keys.findIndex(k=>k.pubkey===identity.wallet),pre=tx.meta.preBalances,post=tx.meta.postBalances;
    need(idx>0&&!keys[idx].signer&&keys.filter(k=>k.pubkey===identity.wallet).length===1&&uint(tx.meta.fee)&&
      pre?.length===keys.length&&post?.length===keys.length&&pre.every(uint)&&post.every(uint)&&
      String(pre[idx])===balanceLamports&&BigInt(post[idx])-BigInt(pre[idx])===amount&&
      BigInt(post[0])-BigInt(pre[0])===-amount-BigInt(tx.meta.fee)&&keys.every((_,i)=>i===0||i===idx||pre[i]===post[i]), 'CONTINUATION_FUNDING_BALANCE_EFFECT');
    balanceLamports=String(post[idx]);
  }
  return {schema:'AUTONOMOUS_REVIEWED_OPENING_ANCHOR_V1',openingSource:'FINALIZED_CLOSED_CONTINUATION',wallet:identity.wallet,finalized:true,
    slot:Number(settlement.slot),balanceLamports,tokens:expected.tokens,latestSignature:final.signature,
    continuation:{...input,stageBasis:basis}};
}

export function validateOpeningAnchor(anchor,{wallet,stageContext}={}) {
  need(anchor?.schema==='AUTONOMOUS_REVIEWED_OPENING_ANCHOR_V1'&&anchor.wallet===wallet&&anchor.finalized===true&&uint(anchor.slot)&&
    raw(anchor.balanceLamports)&&Array.isArray(anchor.tokens)&&anchor.tokens.every(t=>raw(t.raw)&&raw(t.lamports))&&
    (typeof anchor.latestSignature==='string'&&anchor.latestSignature.length>0||anchor.latestSignature===null), 'FACT_REVIEWED_OPENING_ANCHOR_REQUIRED');
  need([undefined,'FIRST_USE_OPENING','FINALIZED_CLOSED_CONTINUATION'].includes(anchor.openingSource),'FACT_OPENING_SOURCE_UNSUPPORTED');
  if(anchor.openingSource==='FINALIZED_CLOSED_CONTINUATION'){
    need(anchor.continuation?.stageBasis,'CONTINUATION_STAGE_BASIS_REQUIRED');
    if(stageContext)for(const k of ['stageDatabase','sourceStageWallet','claimDirectory'])need(anchor.continuation[k]===stageContext[k],'CONTINUATION_CURRENT_STAGE_BINDING');
    const expected=createFinalizedClosedOpening(anchor.continuation);
    need(json(expected)===json(anchor),'CONTINUATION_ANCHOR_CHANGED');
  }else need(!anchor.continuation,'CONTINUATION_MODE_REQUIRED');
  return anchor;
}

export function assessWalletReconciliation({anchor,settlements,wallet,slot,balanceLamports,classic,extended,history}) {
  const expected=expectedAccounts(anchor,settlements,wallet),known=new Set(settlements.map(s=>s.signature));
  if(anchor.continuation?.funding)known.add(anchor.continuation.funding.signature);
  return {unexpectedAssets:json([...tokens(classic,wallet,TOKEN,slot),...tokens(extended,wallet,TOKEN2022,slot)].sort((a,b)=>a.address.localeCompare(b.address)))!==json(expected.tokens),
    unexplainedActivity:history.some(x=>!known.has(x.signature))||String(balanceLamports)!==expected.balanceLamports};
}

/** refresh() must run between service steps, never inside quote/prepare/sign.
 * accountProvider is the SAME sealed instance/store used by observation; its
 * history/quote pacing and request budget are retained. Wallet account methods
 * use the existing Manual read transport because the sealed Research allowlist
 * intentionally excludes them. Both write to the SAME Store and same RPC URL.
 * The first opening anchor and quota/FX refs require independently reviewed facts;
 * a successful RPC never manufactures fresh dashboard quota evidence. */
export function createReadonlyFactsProvider({
  directory,
  store,
  accountProvider,
  providerOptions,
  runtimeDirectory,
  identity,
  openingReference,
  quotaReference,
  fxReference,
  clock,
  refreshIntervalMs = 60000,
  freshnessMs = 120000,
  readNetworkFactory,
  beforeRead = () => {},
  onContextLag = async () => {},
  stageContext,
}) {
  const now = () => clock?.nowMs() ?? Date.now();
  need(
    store?.db &&
      typeof store.reserve === "function" &&
      accountProvider?.store === store,
    "FACT_SHARED_PROVIDER_STORE_REQUIRED",
  );
  need(
    uint(refreshIntervalMs) &&
      refreshIntervalMs >= 30000 &&
      uint(freshnessMs) &&
      freshnessMs >= refreshIntervalMs &&
      freshnessMs <= 300000,
    "FACT_REFRESH_BOUNDS",
  );
  need(
    typeof providerOptions?.rpcUrl === "string" &&
      typeof providerOptions?.quoteKey === "string",
    "FACT_CONFIG_REQUIRED",
  );
  const identityDigest = hash(
      json({
        identity,
        openingReference,
        quotaReference,
        fxReference,
        refreshIntervalMs,
        freshnessMs,
      }),
    ),
    key = "autonomousFacts:" + identityDigest;
  let busy = false;
  const current = () => {
    const x = store.get(key);
    need(x?.facts, "FACT_REFRESH_REQUIRED");
    return structuredClone(x.facts);
  };
  // Refresh against the facts' original absolute expiry, not only the time
  // their slowest request finished. The observed acquisition duration includes
  // the sealed AccountProvider's startup quiet period and later pacing waits.
  const dueAt = (saved, providerOnly = false) => {
    if (!saved?.facts) return 0;
    const completed = providerOnly
      ? (saved.providerRefreshAtMs ?? saved.refreshAtMs)
      : saved.refreshAtMs;
    const started = providerOnly
      ? (saved.providerRefreshStartedAtMs ?? saved.refreshStartedAtMs ?? saved.facts.provider?.observedAtMs)
      : (saved.refreshStartedAtMs ?? saved.facts.provider?.observedAtMs);
    const expiry = providerOnly
      ? saved.facts.provider?.expiresAtMs
      : Math.min(...["wallet", "valuation", "provider", "accounting"].map(name => saved.facts[name]?.expiresAtMs ?? 0));
    if (!uint(completed) || !uint(started) || !uint(expiry)) return 0;
    const acquisitionMs = Math.max(0, completed - started);
    const leadMs = Math.max(refreshIntervalMs, acquisitionMs + 5000);
    return Math.min(completed + refreshIntervalMs, expiry - leadMs);
  };
  let entryRecovery = false;
  const refreshDue = (providerOnly = false) => now() >= dueAt(store.get(key), providerOnly);
  /** An existing liability needs a fresh provider contact, not a new valuation
   * or opening approval. The other sections deliberately retain their original
   * expiry, so this one read cannot make a new entry eligible. */
  async function refreshProviderForResponsibility() {
    need(!busy, "FACT_REFRESH_IN_PROGRESS");
    const active = inspectAutonomousRuntime(runtimeDirectory),
      old = store.get(key),
      started = now();
    need(
      active.state === "INITIALIZED" &&
        json(active.identity) === json(identity) &&
        active.active?.wallet === identity.wallet,
      "FACT_EXISTING_RESPONSIBILITY_REQUIRED",
    );
    need(old?.facts, "FACT_REFRESH_REQUIRED");
    if (!refreshDue(true))
      return current();
    busy = true;
    const runId = randomUUID(),
      deadline = started + 300000;
    let requestId = null,
      receipt = null;
    try {
      const quota = pinned(quotaReference),
        quotaAt = quota.observedAtMs ?? quota.atMs,
        quotaEnd = quota.expiresAtMs ?? quotaAt + 86400000;
      need(
        uint(quotaAt) &&
          uint(quotaEnd) &&
          quotaAt <= started &&
          started < quotaEnd &&
          quota.helius?.plan === "Free" &&
          quota.jupiter?.plan === "Free" &&
          quota.jupiter?.paid_overage === false &&
          quota.helius.conservativeRemainingCalls >= 1,
        "FACT_QUOTA_REFERENCE_EXPIRED_OR_INSUFFICIENT",
      );
      const guard = () => {
        need(now() < deadline, "FACT_REFRESH_DEADLINE");
        const sharedGuard = accountProvider.beforeRequest();
        need(!sharedGuard?.then, "FACT_SYNCHRONOUS_SHARED_GUARD_REQUIRED");
        need(
          store.db
            .prepare(
              "SELECT COUNT(*) n FROM requests WHERE kind='RPC' AND requested>=?",
            )
            .get(quotaAt).n < quota.helius.conservativeRemainingCalls,
          "FACT_EXISTING_QUOTA_EXHAUSTED",
        );
      };
      const audit = {
        maxAltTablesPerMessage: 1,
        assertCurrent: guard,
        requestSignal: () => AbortSignal.timeout(Math.max(1, deadline - now())),
        reserve(kind, method, params) {
          guard();
          const reservedBudgetGuard = beforeRead({ responsibility: true });
          need(
            !reservedBudgetGuard?.then,
            "FACT_SYNCHRONOUS_READ_BUDGET_REQUIRED",
          );
          need(
            kind === "RPC_READ" &&
              method === "getAccountInfo" &&
              requestId === null,
            "FACT_RESPONSIBILITY_ONE_READ_BOUND",
          );
          requestId = store.reserve(
            "facts-responsibility:" + runId,
            "RPC",
            "metadata",
            { method, params, requested_at_ms: now() },
          );
          return requestId;
        },
        complete(id, status, body) {
          need(
            ![providerOptions.rpcUrl, providerOptions.quoteKey]
              .filter(Boolean)
              .some((s) => body.includes(s)),
            "FACT_SECRET_IN_RESPONSE",
          );
          receipt = {
            request_id: id,
            http_status: status,
            body_sha256: hash(body),
            available_at_ms: now(),
            responded_at_ms: now(),
          };
          store.response(id, receipt, body);
        },
        fail(id, reason, phase, details) {
          store.response(
            id,
            {
              request_id: id,
              error: reason,
              phase,
              ...safeFailureDetails(details, providerOptions),
              available_at_ms: now(),
              responded_at_ms: now(),
            },
            "",
          );
        },
        observe(id, phase, fields) {
          store.event("AUTONOMOUS_FACT_TRANSPORT", {
            requestId: id,
            phase,
            ...fields,
          });
        },
      };
      const reader = readNetworkFactory
        ? readNetworkFactory(audit)
        : new WalletFactsNetwork(providerOptions.rpcUrl, audit);
      guard();
      const due = (store.get("lastSend:RPC") ?? 0) + store.config.rpcIntervalMs;
      if (now() < due)
        await (clock?.sleep
          ? clock.sleep(due - now())
          : new Promise((r) => setTimeout(r, due - now())));
      guard();
      store.set("lastSend:RPC", now());
      const minSlot = old.facts.wallet.slot,
        one = await reader.read("getAccountInfo", [
          identity.wallet,
          {
            commitment: "finalized",
            encoding: "base64",
            minContextSlot: minSlot,
          },
        ]);
      need(
        uint(minSlot) &&
          uint(one?.context?.slot) &&
          one.context.slot >= minSlot &&
          one.value?.owner === "11111111111111111111111111111111" &&
          one.value.executable === false &&
          raw(String(one.value.lamports)) &&
          receipt?.http_status === 200,
        "FACT_WALLET_ACCOUNT_CONTRACT",
      );
      const end = now(),
        expiresAtMs = Math.min(started + freshnessMs, quotaEnd);
      need(end < expiresAtMs, "FACT_REFRESH_ALREADY_STALE");
      const provider = writeEvidence(directory, "provider-responsibility", {
        schema: "AUTONOMOUS_PROVIDER_FACT_V1",
        observedAtMs: started,
        expiresAtMs,
        health: "HEALTHY",
        rpcReference: old.facts.provider.rpcReference,
        jupiterReference: old.facts.provider.jupiterReference,
        quotaObservedAtMs: quotaAt,
        quotaExpiresAtMs: quotaEnd,
        healthScope:
          "EXISTING_RESPONSIBILITY_FINALIZED_RPC_READ_ONLY_JUPITER_NOT_REFRESHED",
        finalizedSlot: one.context.slot,
        upstream: {
          quotaReference,
          priorProviderEvidence: old.facts.provider.evidence,
          requestRun: runId,
          receipt,
          episodeId: active.active.episodeId,
        },
      });
      store.atomic(() => {
        need(json(store.get(key)) === json(old), "FACT_CONCURRENT_REFRESH");
        store.set(key, {
          ...old,
          providerRefreshStartedAtMs: started,
          providerRefreshAtMs: end,
          facts: { ...old.facts, provider },
        });
        store.event("AUTONOMOUS_RESPONSIBILITY_PROVIDER_REFRESH", {
          runId,
          episodeId: active.active.episodeId,
          startedAtMs: started,
          completedAtMs: end,
          rpcRequests: 1,
          quoteRequests: 0,
          receipt,
          providerEvidence: provider.evidence,
          openingAndValuationNotRefreshed: true,
        });
      });
      return current();
    } catch (e) {
      store.event("AUTONOMOUS_RESPONSIBILITY_PROVIDER_REFRESH_FAILED", {
        runId,
        startedAtMs: started,
        atMs: now(),
        rpcRequests: requestId === null ? 0 : 1,
        reason: /^[A-Z0-9_]+$/.test(e?.message ?? "")
          ? e.message
          : "FACT_REFRESH_FAILED",
        retry: false,
      });
      throw e;
    } finally {
      busy = false;
    }
  }
  async function refresh({ force = false } = {}) {
    need(!busy, "FACT_REFRESH_IN_PROGRESS");
    const old = store.get(key);
    if (!force && old && !refreshDue())
      return current();
    busy = true;
    const started = now(),
      deadline = started + 300000,
      runId = randomUUID();
    let calls = 0, lastReadFailure = null;
    const oldExpiry = old?.facts
      ? Math.min(...["wallet", "valuation", "provider", "accounting"].map(name => old.facts[name]?.expiresAtMs ?? 0))
      : 0;
    try {
      const anchor = pinned(openingReference),
        quota = pinned(quotaReference),
        fx = pinned(fxReference);
      validateOpeningAnchor(anchor,{wallet:identity.wallet,stageContext});
      const quotaAt = quota.observedAtMs ?? quota.atMs,
        quotaEnd = quota.expiresAtMs ?? quotaAt + 86400000;
      need(
        uint(quotaAt) &&
          uint(quotaEnd) &&
          quotaAt <= started &&
          started < quotaEnd &&
          quota.helius?.plan === "Free" &&
          quota.jupiter?.plan === "Free" &&
          quota.jupiter?.paid_overage === false &&
          quota.helius.conservativeRemainingCalls >= 24,
        "FACT_QUOTA_REFERENCE_EXPIRED_OR_INSUFFICIENT",
      );
      need(
        uint(fx.observedAtMs) &&
          uint(fx.expiresAtMs) &&
          fx.observedAtMs <= started &&
          started < fx.expiresAtMs &&
          uint(fx.cnyPerUsdMicro) &&
          fx.cnyPerUsdMicro > 0 &&
          uint(fx.bufferBps) &&
          fx.bufferBps >= 10000 &&
          fx.usdcUsdAssumption === 1,
        "FACT_FX_REFERENCE_REQUIRED",
      );
      const guard = () => {
        need(now() < deadline, "FACT_REFRESH_DEADLINE");
        if (entryRecovery) need(now() < oldExpiry, "FACT_CONTEXT_LAG_OLD_FACTS_EXPIRED");
        const sharedGuard = accountProvider.beforeRequest();
        need(!sharedGuard?.then, "FACT_SYNCHRONOUS_SHARED_GUARD_REQUIRED");
        need(
          store.db
            .prepare(
              "SELECT COUNT(*) n FROM requests WHERE kind='RPC' AND requested>=?",
            )
            .get(quotaAt).n < quota.helius.conservativeRemainingCalls,
          "FACT_EXISTING_QUOTA_EXHAUSTED",
        );
      };
      const audit = {
        maxAltTablesPerMessage: 1,
        assertCurrent: guard,
        requestSignal: () => AbortSignal.timeout(Math.max(1, deadline - now())),
        reserve(kind, method, params) {
          guard();
          lastReadFailure = null;
          const reservedBudgetGuard = beforeRead();
          need(
            !reservedBudgetGuard?.then,
            "FACT_SYNCHRONOUS_READ_BUDGET_REQUIRED",
          );
          need(
            kind === "RPC_READ" &&
              ["getAccountInfo", "getTokenAccountsByOwner"].includes(method) &&
              ++calls <= 24,
            "FACT_RPC_BOUND",
          );
          return store.reserve(
            "facts:" + runId + ":" + calls,
            "RPC",
            "metadata",
            { method, params, requested_at_ms: now() },
          );
        },
        complete(id, status, body) {
          need(
            ![providerOptions.rpcUrl, providerOptions.quoteKey]
              .filter(Boolean)
              .some((s) => body.includes(s)),
            "FACT_SECRET_IN_RESPONSE",
          );
          store.response(
            id,
            {
              request_id: id,
              http_status: status,
              body_sha256: hash(body),
              available_at_ms: now(),
              responded_at_ms: now(),
            },
            body,
          );
        },
        fail(id, reason, phase, details) {
          lastReadFailure = { id, reason, phase, ...safeFailureDetails(details, providerOptions) };
          store.response(
            id,
            {
              request_id: id,
              error: reason,
              phase,
              ...safeFailureDetails(details, providerOptions),
              available_at_ms: now(),
              responded_at_ms: now(),
            },
            "",
          );
        },
        observe(id, phase, fields) {
          store.event("AUTONOMOUS_FACT_TRANSPORT", {
            requestId: id,
            phase,
            ...fields,
          });
        },
      };
      const reader = readNetworkFactory
        ? readNetworkFactory(audit)
        : new WalletFactsNetwork(providerOptions.rpcUrl, audit);
      const read = async (method, params) => {
        const exact = json(params);
        let recoveryReads = 0;
        for (;;) {
          guard();
          const due = (store.get("lastSend:RPC") ?? 0) + store.config.rpcIntervalMs;
          if (now() < due) await (clock?.sleep ? clock.sleep(due - now()) : new Promise(r => setTimeout(r, due - now())));
          guard();
          need(json(params) === exact, "FACT_RECOVERY_REQUEST_CHANGED");
          store.set("lastSend:RPC", now());
          try { return await reader.read(method, params); }
          catch (e) {
            const failure = lastReadFailure, rpc = failure?.json_rpc_error;
            const minimum = params.at(-1)?.minContextSlot;
            if (e?.message !== "RPC_ERROR" || failure?.reason !== "RPC_ERROR" ||
                failure.phase !== "RPC_RESULT" || failure.http_status !== 200 ||
                rpc?.code !== -32016 || rpc.message !== "Minimum context slot has not been reached" ||
                !uint(minimum) || !uint(rpc.dataContext?.contextSlot) || rpc.dataContext.contextSlot >= minimum) throw e;
            // Startup has no prior proof. Never mint validity from an error.
            need(old?.facts && now() < oldExpiry, "FACT_CONTEXT_LAG_OLD_FACTS_EXPIRED");
            need(recoveryReads < 2, "FACT_CONTEXT_LAG_RECOVERY_EXHAUSTED");
            entryRecovery = true;
            store.event("AUTONOMOUS_FACT_CONTEXT_LAG_RECOVERY", {
              runId, requestId: failure.id, method, params, additionalRead: recoveryReads + 1,
              oldFactsExpiresAtMs: oldExpiry, refreshDeadlineMs: deadline,
              entryPaused: true, jsonRpcError: rpc, atMs: now(),
            });
            // No concurrent Provider reads: observe only between exact attempts.
            // The callback must not allocate a BUY or delay existing liability.
            await onContextLag();
            if (inspectAutonomousRuntime(runtimeDirectory).active) throw Error("FACT_ENTRY_REFRESH_YIELDED_TO_RESPONSIBILITY");
            guard();
            recoveryReads++;
          }
        }
      };
      const one = await read("getAccountInfo", [
        identity.wallet,
        {
          commitment: "finalized",
          encoding: "base64",
          minContextSlot: anchor.slot,
        },
      ]);
      const slot = Number(one?.context?.slot),
        value = one?.value;
      need(
        uint(slot) &&
          slot >= anchor.slot &&
          value?.owner === "11111111111111111111111111111111" &&
          value.executable === false &&
          raw(String(value.lamports)),
        "FACT_WALLET_ACCOUNT_CONTRACT",
      );
      const classic = await read("getTokenAccountsByOwner", [
        identity.wallet,
        { programId: TOKEN },
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          minContextSlot: slot,
        },
      ]);
      const extended = await read("getTokenAccountsByOwner", [
        identity.wallet,
        { programId: TOKEN2022 },
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          minContextSlot: slot,
        },
      ]);
      const history = [],
        refs = [];
      let before,
        complete = false,
        historyHead;
      for (let page = 0; page < 3 && !complete; page++) {
        guard();
        need(++calls <= 24, "FACT_RPC_BOUND");
        const cfg = {
          commitment: "finalized",
          minContextSlot: slot,
          limit: 100,
          ...(before ? { before } : {}),
        };
        const r = await accountProvider.request(
          "RPC",
          "metadata",
          "facts:" + runId + ":history:" + page,
          { method: "getSignaturesForAddress", params: [identity.wallet, cfg] },
          deadline,
        );
        need(!r.error && Array.isArray(r.data), "FACT_HISTORY_UNAVAILABLE");
        refs.push(r.receipt);
        if (page === 0) historyHead = r.data[0]?.signature ?? null;
        for (const x of r.data) {
          need(
            typeof x.signature === "string" &&
              uint(x.slot) &&
              x.confirmationStatus === "finalized",
            "FACT_HISTORY_CONTRACT",
          );
          if (x.signature === anchor.latestSignature) {
            complete = true;
            break;
          }
          history.push(x);
        }
        if (r.data.length < 100 && !complete) {
          complete = anchor.latestSignature === null;
          break;
        }
        before = r.data.at(-1)?.signature;
      }
      need(complete, "FACT_HISTORY_COVERAGE_INCOMPLETE");
      const second = await read("getAccountInfo", [
        identity.wallet,
        { commitment: "finalized", encoding: "base64", minContextSlot: slot },
      ]);
      need(
        Number(second?.context?.slot) >= slot &&
          String(second.value?.lamports) === String(value.lamports),
        "FACT_ACCOUNT_CHANGED_DURING_REFRESH",
      );
      guard();
      need(++calls <= 24, "FACT_RPC_BOUND");
      const head = await accountProvider.request(
        "RPC",
        "metadata",
        "facts:" + runId + ":history-final",
        {
          method: "getSignaturesForAddress",
          params: [
            identity.wallet,
            { commitment: "finalized", minContextSlot: slot, limit: 1 },
          ],
        },
        deadline,
      );
      need(
        !head.error &&
          Array.isArray(head.data) &&
          (head.data[0]?.signature ?? null) === historyHead,
        "FACT_HISTORY_CHANGED_DURING_REFRESH",
      );
      refs.push(head.receipt);
      const accounting = readFinalizedRuntimeAccounting({
          runtimeDirectory,
          identity,
          nowMs: now(),
        });
      // Reuse the existing finalized reader for each pinned predecessor. A
      // successor opening must not reset today's earlier loss or count it twice.
      const readRuntimes=new Set([runtimeDirectory]),seenOpenings=new Set();
      for(let previous=anchor;previous.openingSource==='FINALIZED_CLOSED_CONTINUATION';){
        const c=previous.continuation,ref=c.priorOpeningReference;
        need(previous.wallet===identity.wallet&&!seenOpenings.has(ref.path),'CONTINUATION_OPENING_CHAIN');seenOpenings.add(ref.path);
        if(!readRuntimes.has(c.runtimeDirectory)){
          const prior=readFinalizedRuntimeAccounting({...c,nowMs:now()});readRuntimes.add(c.runtimeDirectory);
          need(prior.wallet===identity.wallet&&!prior.settlements.some(s=>accounting.settlements.some(x=>x.signature===s.signature)),'CONTINUATION_DUPLICATE_SETTLEMENT');
          accounting.dailyRealizedNetLamports=(BigInt(accounting.dailyRealizedNetLamports)+BigInt(prior.dailyRealizedNetLamports)).toString();
          accounting.unknownCosts=[...new Set([...accounting.unknownCosts,...prior.unknownCosts])];
          accounting.unknownCostBreakdown=[...new Set([...accounting.unknownCostBreakdown,...prior.unknownCostBreakdown])];
          accounting.settlements.push(...prior.settlements);
        }
        previous=pinned(ref);
      }
      const {unexpectedAssets,unexplainedActivity}=assessWalletReconciliation({anchor,settlements:accounting.settlements,wallet:identity.wallet,slot,balanceLamports:String(value.lamports),classic,extended,history});
      const q = await accountProvider.request(
        "QUOTE",
        "mark",
        "facts:" + runId + ":valuation",
        {
          inputMint: SOL,
          outputMint: USDC,
          amount: "1000000000",
          slippageBps: "50",
          swapMode: "ExactIn",
        },
        deadline,
      );
      need(
        !q.error &&
          q.data?.inputMint === SOL &&
          q.data.outputMint === USDC &&
          q.data.inAmount === "1000000000" &&
          raw(q.data.outAmount) &&
          BigInt(q.data.outAmount) > 0n &&
          q.data.swapMode === "ExactIn" &&
          q.data.routePlan?.length,
        "FACT_VALUATION_QUOTE_CONTRACT",
      );
      const rate =
        (BigInt(q.data.outAmount) *
          BigInt(fx.cnyPerUsdMicro) *
          BigInt(fx.bufferBps) +
          9999999999n) /
        10000000000n;
      need(
        rate > 0n && rate <= BigInt(Number.MAX_SAFE_INTEGER),
        "FACT_VALUATION_RANGE",
      );
      const end = now(),
        expiresAtMs = Math.min(started + freshnessMs, quotaEnd),
        upstream = {
          openingReference,
          quotaReference,
          fxReference,
          requestRun: runId,
          historyReceiptIds: refs.map((x) => x.request_id),
          quoteRequestId: q.receipt.request_id,
        };
      if (entryRecovery) need(end < oldExpiry, "FACT_CONTEXT_LAG_OLD_FACTS_EXPIRED");
      need(end < expiresAtMs, "FACT_REFRESH_ALREADY_STALE");
      const { settlements, ...accountingSummary } = accounting;
      const facts = {
        wallet: writeEvidence(directory, "wallet", {
          schema: "AUTONOMOUS_WALLET_FACT_V1",
          observedAtMs: started,
          expiresAtMs,
          wallet: identity.wallet,
          finalized: true,
          slot,
          balanceLamports: String(value.lamports),
          unexplainedActivity,
          unexpectedAssets,
          historyCoverage: "COMPLETE_TO_REVIEWED_ANCHOR_BOUNDED_300",
          scope: "RPC_TRUST_NOT_CRYPTOGRAPHIC_PROOF",
          upstream,
        }),
        valuation: writeEvidence(directory, "valuation", {
          schema: "AUTONOMOUS_VALUATION_FACT_V1",
          observedAtMs: q.receipt.available_at_ms,
          expiresAtMs: Math.min(end + freshnessMs, fx.expiresAtMs, quotaEnd),
          cnyPerSolMicro: Number(rate),
          fxObservedAtMs: fx.observedAtMs,
          notActualConversion: true,
          upstream,
        }),
        provider: writeEvidence(directory, "provider", {
          schema: "AUTONOMOUS_PROVIDER_FACT_V1",
          observedAtMs: started,
          expiresAtMs,
          health: "HEALTHY",
          rpcReference:
            "CURRENT_CONFIG_HELIUS_RPC_SHA256:" + hash(providerOptions.rpcUrl),
          jupiterReference:
            "CURRENT_CONFIG_JUPITER_KEY_SHA256:" +
            hash(providerOptions.quoteKey),
          quotaObservedAtMs: quotaAt,
          quotaExpiresAtMs: quotaEnd,
          healthScope: "THIS_BOUNDED_READ_AND_QUOTE_ONLY",
          upstream,
        }),
        accounting: writeEvidence(directory, "accounting", {
          schema: "AUTONOMOUS_ACCOUNTING_FACT_V1",
          observedAtMs: end,
          expiresAtMs: Math.min(
            end + freshnessMs,
            Date.parse(accounting.utcDay + "T00:00:00.000Z") + 86400000,
          ),
          ...accountingSummary,
          settlementSignatures: settlements.map((s) => s.signature),
          upstream,
        }),
      };
      store.atomic(() => {
        store.set(key, { refreshStartedAtMs: started, refreshAtMs: end, facts });
        store.event("AUTONOMOUS_FACT_REFRESH", {
          runId,
          startedAtMs: started,
          completedAtMs: end,
          rpcRequests: calls,
          quoteRequests: 1,
          unexplainedActivity,
          unexpectedAssets,
          files: Object.fromEntries(
            Object.entries(facts).map(([k, v]) => [k, v.evidence]),
          ),
        });
      });
      return current();
    } catch (e) {
      store.event("AUTONOMOUS_FACT_REFRESH_FAILED", {
        runId,
        startedAtMs: started,
        atMs: now(),
        rpcRequests: calls,
        reason: /^[A-Z0-9_]+$/.test(e?.message ?? "")
          ? e.message
          : "FACT_REFRESH_FAILED",
        retry: false,
      });
      if (e?.message === "FACT_ENTRY_REFRESH_YIELDED_TO_RESPONSIBILITY") return current();
      throw e;
    } finally {
      entryRecovery = false;
      busy = false;
    }
  }
  return {
    current,
    refresh,
    refreshProviderForResponsibility,
    refreshDue: () => refreshDue(),
    providerRefreshDue: () => refreshDue(true),
    entryRecoveryPending: () => entryRecovery,
    referenceDigest: identityDigest,
  };
}
