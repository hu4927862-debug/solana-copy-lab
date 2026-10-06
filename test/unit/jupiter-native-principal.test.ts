import bs58 from "bs58";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { RawTransactionSchema } from "../../src/decoder/raw-transaction.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
const sell = RawTransactionSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/v5-jupiter-sell-with-output-fee.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const buy = RawTransactionSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../fixtures/v5-jupiter-buy-with-refund.json", import.meta.url),
      "utf8",
    ),
  ),
);
const classify = (raw: typeof sell) =>
  new SwapClassifier().classify(
    new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
    raw.feePayer,
  );
describe("Jupiter route net native principal", () => {
  it.each([
    "missing trace",
    "truncated trace",
    "spoofed return",
    "wrong return",
    "wrong token principal",
    "second route",
    "unrelated outer token transfer",
  ])("keeps %s rejected", (fault) => {
    const raw = structuredClone(sell);
    const jup = raw.outerInstructions.find((i) =>
      i.programId.startsWith("JUP6"),
    )!;
    if (fault === "missing trace") raw.logMessages = [];
    if (fault === "truncated trace") raw.logMessages.pop();
    if (fault === "spoofed return")
      raw.logMessages = raw.logMessages.map((l) =>
        l.startsWith("Program return: JUP6") ? "Program log: " + l : l,
      );
    if (fault === "wrong return")
      raw.logMessages = raw.logMessages.map((l) =>
        l.startsWith("Program return: JUP6")
          ? l.split(" ").slice(0, 3).join(" ") + " AQAAAAAAAAA="
          : l,
      );
    if (fault === "wrong token principal") {
      const balance = raw.preTokenBalances.find(
        (b) => b.owner === raw.feePayer && b.mint === jup.accounts[3],
      )!;
      balance.rawAmount = (BigInt(balance.rawAmount) + 1n).toString();
    }
    if (fault === "second route") raw.outerInstructions.push(jup);
    if (fault === "unrelated outer token transfer")
      raw.outerInstructions.push(
        raw.innerInstructions.find(
          (i) =>
            i.programId.startsWith("Tokenkeg") &&
            i.accounts[0] === jup.accounts[2] &&
            i.data?.startsWith("base58:"),
        )!,
      );
    expect(classify(raw)).toMatchObject({
      accepted: false,
      code: "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
    });
  });
  it("rejects an incoming transfer larger than the earlier payment to that counterparty", () => {
    const raw = structuredClone(buy);
    const jup = raw.outerInstructions.find((i) =>
      i.programId.startsWith("JUP6"),
    )!;
    const refund = raw.innerInstructions.findLast(
      (i) =>
        i.programId.startsWith("Tokenkeg") && i.accounts[2] === jup.accounts[1],
    )!;
    const data = Buffer.from(bs58.decode(refund.data!.slice(7)));
    data.writeBigUInt64LE(2964n, 1);
    refund.data = "base58:" + bs58.encode(data);
    expect(classify(raw)).toMatchObject({
      accepted: false,
      code: "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
    });
  });

  it("recognizes output after the routed deduction without counting wallet transfers", () => {
    const r = classify(sell);
    expect(r.accepted).toBe(true);
    if (!r.accepted) throw new Error(r.code);
    expect(r.event.side).toBe("SELL");
    expect(r.event.quote.raw).toBe(7816843n);
  });
  it("rejects cashback funded before the current route", () => {
    const raw = structuredClone(buy);
    const jup = raw.outerInstructions.find((i) =>
      i.programId.startsWith("JUP6"),
    )!;
    const refund = raw.innerInstructions.findLast(
      (i) =>
        i.programId.startsWith("Tokenkeg") && i.accounts[2] === jup.accounts[1],
    )!;
    const pre = raw.preTokenBalances.find(
      (b) => raw.accountKeys[b.accountIndex]?.address === refund.accounts[0],
    )!;
    pre.rawAmount = "1";
    expect(classify(raw)).toMatchObject({
      accepted: false,
      code: "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
    });
  });
  it("recognizes an exact returned input-side transfer without inflating principal", () => {
    const r = classify(buy);
    expect(r.accepted).toBe(true);
    if (!r.accepted) throw new Error(r.code);
    expect(r.event.side).toBe("BUY");
    expect(r.event.quote.raw).toBe(997037n);
  });
  it("rejects a refund account receiving separate native funding", () => {
    const raw = structuredClone(buy);
    const jup = raw.outerInstructions.find((i) =>
      i.programId.startsWith("JUP6"),
    )!;
    const refund = raw.innerInstructions.findLast(
      (i) =>
        i.programId.startsWith("Tokenkeg") && i.accounts[2] === jup.accounts[1],
    )!;
    const funding = raw.outerInstructions.find(
      (i) =>
        i.programId === "11111111111111111111111111111111" &&
        i.accounts.length === 2,
    )!;
    funding.accounts[1] = refund.accounts[0]!;
    expect(classify(raw)).toMatchObject({
      accepted: false,
      code: "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
    });
  });
});
