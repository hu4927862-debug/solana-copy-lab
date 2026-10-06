import { NATIVE_SOL, USDC_MINT, WSOL_MINT } from "../../src/domain/assets.js";
import { PROGRAM_IDS } from "../../src/decoder/program-registry.js";
import type { RawTransaction } from "../../src/decoder/raw-transaction.js";

export const LEADER_A = "7YttLkHDoNj9wyDur5ejbJjDkAxJecYtgHhnrv8kE2mQ";
export const LEADER_B = "9xQeWvG816bUx9EPfEZmYwJ9GJz9Dk8pK2S3g6R6D6Hh";
export const FOLLOWER = "3fS8vY2w4qQJt3i5sC1dL7mN9xR6pK8uV2aB4eG7hJ9k";
export const TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6LKH5mRk5kMZQ";
export const SECOND_TOKEN_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";

interface FixtureOptions {
  readonly name: string;
  readonly programId: string;
  readonly parsedType: string;
  readonly side: "BUY" | "SELL";
  readonly version?: "legacy" | 0;
  readonly leader?: string;
  readonly tokenMint?: string;
  readonly quoteMint?: string;
  readonly tokenRaw?: bigint;
  readonly quoteRaw?: bigint;
  readonly preTokenRaw?: bigint;
  readonly inner?: boolean;
  readonly logs?: readonly string[];
}

function signature(name: string): string {
  return `${name.replace(/[^A-Za-z0-9]/g, "")}5zQw9gC2mV7rK4pX8nD6sH3jF1aB9uE5tL2yR7oP4iN6kM8cW3qS1vG9`;
}

export function swapFixture(options: FixtureOptions): RawTransaction {
  const leader = options.leader ?? LEADER_A;
  const tokenMint = options.tokenMint ?? TOKEN_MINT;
  const quoteMint = options.quoteMint ?? NATIVE_SOL;
  const tokenRaw = options.tokenRaw ?? 2_000_000n;
  const quoteRaw = options.quoteRaw ?? 1_000_000_000n;
  const preTokenRaw =
    options.preTokenRaw ?? (options.side === "BUY" ? 0n : 10_000_000n);
  const postTokenRaw =
    options.side === "BUY" ? preTokenRaw + tokenRaw : preTokenRaw - tokenRaw;
  const feeRaw = 5_000n;
  const preSol = 10_000_000_000n;
  const postSol =
    quoteMint === NATIVE_SOL
      ? options.side === "BUY"
        ? preSol - quoteRaw - feeRaw
        : preSol + quoteRaw - feeRaw
      : preSol - feeRaw;
  const quoteTokenIndex = 4;
  const accountKeys = [
    {
      address: leader,
      signer: true,
      writable: true,
      source: "MESSAGE" as const,
    },
    {
      address: options.programId,
      signer: false,
      writable: false,
      source: "MESSAGE" as const,
    },
    {
      address: PROGRAM_IDS.TOKEN,
      signer: false,
      writable: false,
      source: "MESSAGE" as const,
    },
    {
      address: "TokenAccount111111111111111111111111111111",
      signer: false,
      writable: true,
      source: "MESSAGE" as const,
    },
    {
      address: "QuoteAccount111111111111111111111111111111",
      signer: false,
      writable: true,
      source: "MESSAGE" as const,
    },
    ...(options.version === 0
      ? [
          {
            address: "LookupAddress1111111111111111111111111111",
            signer: false,
            writable: true,
            source: "LOOKUP_WRITABLE" as const,
          },
        ]
      : []),
  ];
  const preTokenBalances: RawTransaction["preTokenBalances"] = [
    {
      accountIndex: 3,
      mint: tokenMint,
      owner: leader,
      rawAmount: preTokenRaw.toString(),
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    },
  ];
  const postTokenBalances: RawTransaction["postTokenBalances"] = [
    {
      accountIndex: 3,
      mint: tokenMint,
      owner: leader,
      rawAmount: postTokenRaw.toString(),
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    },
  ];
  if (quoteMint !== NATIVE_SOL) {
    const preQuote = 20_000_000_000n;
    const postQuote =
      options.side === "BUY" ? preQuote - quoteRaw : preQuote + quoteRaw;
    preTokenBalances.push({
      accountIndex: quoteTokenIndex,
      mint: quoteMint,
      owner: leader,
      rawAmount: preQuote.toString(),
      decimals: quoteMint === USDC_MINT ? 6 : 9,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
    postTokenBalances.push({
      accountIndex: quoteTokenIndex,
      mint: quoteMint,
      owner: leader,
      rawAmount: postQuote.toString(),
      decimals: quoteMint === USDC_MINT ? 6 : 9,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
  }
  const instruction = {
    programId: options.programId,
    accounts: [leader],
    data: "AQID",
    parsedType: options.parsedType,
  };
  return {
    signature: signature(options.name),
    slot: "289000001",
    version: options.version ?? "legacy",
    success: true,
    error: null,
    feeRaw: feeRaw.toString(),
    feePayer: leader,
    accountKeys,
    preBalances: accountKeys.map((_account, index) =>
      index === 0 ? preSol.toString() : "2039280",
    ),
    postBalances: accountKeys.map((_account, index) =>
      index === 0 ? postSol.toString() : "2039280",
    ),
    preTokenBalances,
    postTokenBalances,
    outerInstructions: options.inner ? [] : [instruction],
    innerInstructions: options.inner
      ? [{ ...instruction, stackHeight: 2 }]
      : [],
    logMessages: [
      ...(options.logs ?? [`Program log: Instruction: ${options.parsedType}`]),
    ],
    sourceTimestampMs: 1_730_000_000_123,
    sourceTimestampPrecision: "MILLISECOND",
    sourceTimestampProvenance: "CHAIN_BLOCK_TIME",
  };
}

export const MAINNET_FIXTURES = {
  jupiterBuy: swapFixture({
    name: "jupiter-buy",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    side: "BUY",
    version: 0,
    inner: true,
  }),
  jupiterSell: swapFixture({
    name: "jupiter-sell",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    side: "SELL",
    version: 0,
    inner: true,
  }),
  raydiumBuy: swapFixture({
    name: "raydium-buy",
    programId: PROGRAM_IDS.RAYDIUM_AMM_V4,
    parsedType: "swapBaseIn",
    side: "BUY",
  }),
  raydiumSell: swapFixture({
    name: "raydium-sell",
    programId: PROGRAM_IDS.RAYDIUM_AMM_V4,
    parsedType: "swapBaseOut",
    side: "SELL",
  }),
  pumpFunBuy: swapFixture({
    name: "pumpfun-buy",
    programId: PROGRAM_IDS.PUMP_FUN,
    parsedType: "buy",
    side: "BUY",
  }),
  pumpSwapSell: swapFixture({
    name: "pumpswap-sell",
    programId: PROGRAM_IDS.PUMP_SWAP,
    parsedType: "sell",
    side: "SELL",
  }),
  multiHopJupiter: swapFixture({
    name: "jupiter-multihop",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    side: "BUY",
    version: 0,
    inner: true,
    quoteMint: USDC_MINT,
  }),
  partialSell: swapFixture({
    name: "partial-sell",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    side: "SELL",
    tokenRaw: 2_500_000n,
    preTokenRaw: 10_000_000n,
  }),
  fullSell: swapFixture({
    name: "full-sell",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    side: "SELL",
    tokenRaw: 10_000_000n,
    preTokenRaw: 10_000_000n,
  }),
  wsolBuy: swapFixture({
    name: "wsol-buy",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    side: "BUY",
    quoteMint: WSOL_MINT,
  }),
};

export const NEGATIVE_FIXTURES = {
  solTransfer: {
    ...swapFixture({
      name: "sol-transfer",
      programId: PROGRAM_IDS.SYSTEM,
      parsedType: "transfer",
      side: "BUY",
    }),
    preTokenBalances: [],
    postTokenBalances: [],
    logMessages: ["Program log: transfer"],
  },
  splTransfer: {
    ...swapFixture({
      name: "spl-transfer",
      programId: PROGRAM_IDS.TOKEN,
      parsedType: "transferChecked",
      side: "SELL",
    }),
    logMessages: ["Program log: Instruction: TransferChecked"],
  },
  ataCreate: {
    ...swapFixture({
      name: "ata-create",
      programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      parsedType: "create",
      side: "BUY",
    }),
    preTokenBalances: [],
    postTokenBalances: [],
    logMessages: ["Program log: Create associated token account"],
  },
  liquidityOperation: swapFixture({
    name: "liquidity-add",
    programId: PROGRAM_IDS.RAYDIUM_AMM_V4,
    parsedType: "addLiquidity",
    side: "BUY",
    logs: ["Program log: Instruction: AddLiquidity"],
  }),
};

interface CapturedSwap {
  readonly signature: string;
  readonly slot: string;
  readonly blockTime: number;
  readonly leader: string;
  readonly programId: string;
  readonly parsedType: string;
  readonly tokenMint: string;
  readonly tokenPreRaw: string;
  readonly tokenPostRaw: string;
  readonly quoteMint: string;
  readonly quotePreRaw?: string;
  readonly quotePostRaw?: string;
  readonly solDeltaRaw: string;
  readonly feeRaw: string;
}

function capturedSwap(capture: CapturedSwap): RawTransaction {
  const nativeQuote = capture.quoteMint === NATIVE_SOL;
  const preSol = 20_000_000_000n;
  const postSol = preSol + BigInt(capture.solDeltaRaw) - BigInt(capture.feeRaw);
  const accounts = [
    {
      address: capture.leader,
      signer: true,
      writable: true,
      source: "MESSAGE" as const,
    },
    {
      address: capture.programId,
      signer: false,
      writable: false,
      source: "MESSAGE" as const,
    },
    {
      address: PROGRAM_IDS.TOKEN,
      signer: false,
      writable: false,
      source: "MESSAGE" as const,
    },
    {
      address: "CapturedTokenAccount11111111111111111111111",
      signer: false,
      writable: true,
      source: "MESSAGE" as const,
    },
    {
      address: "CapturedQuoteAccount11111111111111111111111",
      signer: false,
      writable: true,
      source: "LOOKUP_WRITABLE" as const,
    },
  ];
  const preTokenBalances: RawTransaction["preTokenBalances"] = [
    {
      accountIndex: 3,
      mint: capture.tokenMint,
      owner: capture.leader,
      rawAmount: capture.tokenPreRaw,
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    },
  ];
  const postTokenBalances: RawTransaction["postTokenBalances"] = [
    {
      accountIndex: 3,
      mint: capture.tokenMint,
      owner: capture.leader,
      rawAmount: capture.tokenPostRaw,
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    },
  ];
  if (!nativeQuote) {
    preTokenBalances.push({
      accountIndex: 4,
      mint: capture.quoteMint,
      owner: capture.leader,
      rawAmount: capture.quotePreRaw ?? "0",
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
    postTokenBalances.push({
      accountIndex: 4,
      mint: capture.quoteMint,
      owner: capture.leader,
      rawAmount: capture.quotePostRaw ?? "0",
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
  }
  return {
    signature: capture.signature,
    slot: capture.slot,
    version: 0,
    success: true,
    error: null,
    feeRaw: capture.feeRaw,
    feePayer: capture.leader,
    accountKeys: accounts,
    preBalances: accounts.map((_value, index) =>
      index === 0 ? preSol.toString() : "2039280",
    ),
    postBalances: accounts.map((_value, index) =>
      index === 0 ? postSol.toString() : "2039280",
    ),
    preTokenBalances,
    postTokenBalances,
    outerInstructions: [
      {
        programId: capture.programId,
        accounts: [capture.leader],
        data: "AQID",
        parsedType: capture.parsedType,
      },
    ],
    innerInstructions: [],
    logMessages: [`Program log: Instruction: ${capture.parsedType}`],
    sourceTimestampMs: capture.blockTime * 1_000,
    sourceTimestampPrecision: "SECOND",
    sourceTimestampProvenance: "CHAIN_BLOCK_TIME",
  };
}

export const REAL_MAINNET_FIXTURES = {
  jupiterBuy: capturedSwap({
    signature:
      "26t1fGocdKT3q7WqRJoxb8moj1f9tPXuvxLQkmabMQ2Q2tFXhesRGpDCT5AyukNubBkZzXbYKaZ1xphDHkbSUDjE",
    slot: "440699769",
    blockTime: 1787320259,
    leader: "FrhLfj81LRpMR3EwSSCGPzHmxsnoq8h628ne68vK5oMN",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "route",
    tokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    tokenPreRaw: "54820663544",
    tokenPostRaw: "55070968833",
    quoteMint: USDC_MINT,
    quotePreRaw: "65101029442",
    quotePostRaw: "64919594677",
    solDeltaRaw: "-527600",
    feeRaw: "16192",
  }),
  jupiterSell: capturedSwap({
    signature:
      "5qnbnCeX1cqPTXid2vCE2KfpHqajnyQvx2Ys2ETThDoT5njJ2HnandpJxcr3G6po8ydQo85x1sfhqhZ1jtWHsDxv",
    slot: "440699769",
    blockTime: 1787320259,
    leader: "CBFB4dhq5wLvbYFoemedBNnxqV8pxarANtTMWr8Zb7Cu",
    programId: PROGRAM_IDS.JUPITER_V6,
    parsedType: "swapV2",
    tokenMint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    tokenPreRaw: "220167728",
    tokenPostRaw: "69",
    quoteMint: USDC_MINT,
    quotePreRaw: "2790251344",
    quotePostRaw: "3010465744",
    solDeltaRaw: "0",
    feeRaw: "5030",
  }),
  raydiumBuy: capturedSwap({
    signature:
      "4ZWrN9qWzhqvev7H92FXanhvVHtRize1mTwQBwoiBSNhVWt1Ax9HvQpUSJEPhJW5wao9FwmB9VmQ1Romz1Y8aU3",
    slot: "440699947",
    blockTime: 1787320324,
    leader: "EsM56zsTpZN54WjuFNDVRckz5KDLM7QqDKScZY15M3eZ",
    programId: PROGRAM_IDS.RAYDIUM_AMM_V4,
    parsedType: "buyExactQuoteInV2",
    tokenMint: "FhBfSgb1Nxu53kDR9sgHoHYRMoV1dvyL4rd1wn8cpump",
    tokenPreRaw: "4640170809811",
    tokenPostRaw: "12599625441589",
    quoteMint: NATIVE_SOL,
    solDeltaRaw: "-1173033927",
    feeRaw: "9000",
  }),
  raydiumSell: capturedSwap({
    signature:
      "wjqL7xDtUaT5q8WC9tSQea4DyPJXPPhNbasqWwmULsy4KiMUVDyZY9k3nwpQAnzMAxvuF7HmhG1nX97ri64uNDd",
    slot: "440700052",
    blockTime: 1787320363,
    leader: "14gdEtVDvNFeSm6BqDaKRAW4q9SHSkbPBGP77ntXMyRJ",
    programId: PROGRAM_IDS.RAYDIUM_AMM_V4,
    parsedType: "sellV2",
    tokenMint: "7XdvsEuhzejEADSHqz2CY6HuATyGs4Ed6R4Uz6e5pump",
    tokenPreRaw: "17014758807709",
    tokenPostRaw: "0",
    quoteMint: NATIVE_SOL,
    solDeltaRaw: "488309715",
    feeRaw: "9956",
  }),
  pumpFunBuy: capturedSwap({
    signature:
      "4hYJCV7UzeoBkUMgoBbCehPf9eWLHpNHcfnq4q66mdoNwVoqsJ2SX3QTJBSsEzqRJp5iSAr7rfSVaSbFT23N5ry1",
    slot: "440699772",
    blockTime: 1787320260,
    leader: "FoZXh8qZBa7zUY5Uoms3hH1K2BbJEtRPZv6QBPbGfbmn",
    programId: PROGRAM_IDS.PUMP_FUN,
    parsedType: "buy",
    tokenMint: "3FXtVr8DmtubnsEK5kUXxDSV6hALQwhC9HMBa542pump",
    tokenPreRaw: "0",
    tokenPostRaw: "1852732340316",
    quoteMint: NATIVE_SOL,
    solDeltaRaw: "-181580594",
    feeRaw: "1005000",
  }),
  pumpFunSell: capturedSwap({
    signature:
      "GGKoveRNVdtViSpduqqCG47fNZZ5Aa1gg9PaCt5J8f1Bht64bibLSRXkmzR37wtQHo7CzFGxMpYUDCanCFK94vy",
    slot: "440699968",
    blockTime: 1787320331,
    leader: "nya666pQkP3PzWxi7JngU3rRMHuc7zbLK8c8wxQ4qpT",
    programId: PROGRAM_IDS.PUMP_FUN,
    parsedType: "sellV2",
    tokenMint: "GhhysRSkGAK89VZHuXdRYJGQr7SZBe2Bab3h2rFnpump",
    tokenPreRaw: "2181354901433",
    tokenPostRaw: "0",
    quoteMint: NATIVE_SOL,
    solDeltaRaw: "104403945",
    feeRaw: "32443",
  }),
  pumpSwapBuy: capturedSwap({
    signature:
      "4qzwgeCj3LAc86rMMbzwdsYex3TL7GcpfHQsyGDESqJuZU29sHsh1B5no5XPmkAcUcnbh83X4vGNcwTVGWu3n3QZ",
    slot: "440699953",
    blockTime: 1787320326,
    leader: "6CWmPQD8tDLatj2s8BVEiZTMycn73qmJney796dEGf7V",
    programId: PROGRAM_IDS.PUMP_SWAP,
    parsedType: "buyExactQuoteIn",
    tokenMint: "8du34ohgGj2ikZVTGZNwHbNbqX8b8AHGFANf6qmopump",
    tokenPreRaw: "8942368762",
    tokenPostRaw: "16194622771",
    quoteMint: NATIVE_SOL,
    solDeltaRaw: "-303100000",
    feeRaw: "1005000",
  }),
  pumpSwapSell: capturedSwap({
    signature:
      "4LDRTFeeH6hXDEXCVUh4T7cnKn8U6kaA8zRaiZiifCGfyqiQh1emYV7ZRxDP1Xz8M8pxKra3Nbfae48T9Kowe8WQ",
    slot: "440700059",
    blockTime: 1787320365,
    leader: "CkUZV387xnoGpF7wC2moMa6mPmAgCvTT4pWgzq4M9fCD",
    programId: PROGRAM_IDS.PUMP_SWAP,
    parsedType: "sell",
    tokenMint: "At8fKxJjiK9GV7KNQocTjmpNBtXLZpX5jTA6dWakpump",
    tokenPreRaw: "4025269672383",
    tokenPostRaw: "2683513114922",
    quoteMint: NATIVE_SOL,
    solDeltaRaw: "152676306",
    feeRaw: "65000",
  }),
};
