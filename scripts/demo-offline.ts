import assert from "node:assert/strict";
import { TransactionNormalizer } from "../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../src/decoder/swap-classifier.js";
import { PROGRAM_IDS } from "../src/decoder/program-registry.js";
import type { RawTransaction } from "../src/decoder/raw-transaction.js";
import {
  LEADER_A,
  MAINNET_FIXTURES,
  NEGATIVE_FIXTURES,
  swapFixture,
} from "../test/fixtures/mainnet-fixtures.js";
import { envelope } from "../test/helpers/envelope.js";
import { TestClock } from "../test/helpers/test-clock.js";

// MAINNET_FIXTURES is constructed by swapFixture. These are synthetic cases;
// this demo deliberately does not use REAL_MAINNET_FIXTURES or sealed owners.
const exactLargeTokenRaw = 9_007_199_254_740_993n;
const cases: readonly {
  name: string;
  transaction: RawTransaction;
  expected: "BUY" | "SELL" | "ORDINARY_TRANSFER" | "TRANSACTION_FAILED";
}[] = [
  {
    name: "synthetic-buy",
    transaction: MAINNET_FIXTURES.jupiterBuy,
    expected: "BUY",
  },
  {
    name: "synthetic-sell",
    transaction: MAINNET_FIXTURES.jupiterSell,
    expected: "SELL",
  },
  {
    name: "synthetic-buy-above-number-safe-integer",
    transaction: swapFixture({
      name: "precision-boundary-buy",
      programId: PROGRAM_IDS.JUPITER_V6,
      parsedType: "route",
      side: "BUY",
      tokenRaw: exactLargeTokenRaw,
      quoteRaw: 123_456_789n,
    }),
    expected: "BUY",
  },
  {
    name: "synthetic-ordinary-transfer",
    transaction: NEGATIVE_FIXTURES.splTransfer,
    expected: "ORDINARY_TRANSFER",
  },
  {
    name: "synthetic-failed-transaction",
    transaction: {
      ...MAINNET_FIXTURES.jupiterBuy,
      success: false,
      error: "Synthetic instruction failure",
    },
    expected: "TRANSACTION_FAILED",
  },
];

const normalizer = new TransactionNormalizer(new TestClock());
const classifier = new SwapClassifier();
const results = cases.map(({ name, transaction, expected }) => {
  const classification = classifier.classify(
    normalizer.normalize(envelope(transaction)),
    LEADER_A,
  );
  const actual = classification.accepted
    ? classification.event.side
    : classification.code;
  assert.equal(actual, expected, `Unexpected classification for ${name}`);

  if (!classification.accepted) {
    return {
      name,
      result: "REJECT",
      code: classification.code,
      details: classification.details,
    };
  }

  const { event } = classification;
  if (name === "synthetic-buy-above-number-safe-integer") {
    assert.equal(event.token.raw, exactLargeTokenRaw);
  }
  return {
    name,
    result: "ACCEPT",
    side: event.side,
    dex: event.dex,
    token: {
      mint: event.token.mint,
      raw: event.token.raw.toString(),
      decimals: event.token.decimals,
    },
    quote: {
      mint: event.quote.mint,
      raw: event.quote.raw.toString(),
      decimals: event.quote.decimals,
    },
    amountRepresentation: "bigint internally; exact decimal strings in JSON",
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      project: "Solana Copy Lab",
      mode: "SYNTHETIC_OFFLINE",
      scope:
        "Decoder demonstration only. No credentials, database, network, signing or sending.",
      evidenceBoundary:
        "Classification is not a FOLLOW signal, execution qualification, funds authorization or profitability evidence.",
      results,
    },
    null,
    2,
  )}\n`,
);
