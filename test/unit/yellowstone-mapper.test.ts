import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { PROGRAM_IDS } from "../../src/decoder/program-registry.js";
import { mapYellowstoneTransaction } from "../../src/stream/yellowstone-mapper.js";
import { LEADER_A, TOKEN_MINT } from "../fixtures/mainnet-fixtures.js";

describe("Yellowstone protobuf boundary mapper", () => {
  it("maps v0 loaded addresses, CPI, token balances, and receive timestamps", () => {
    const tokenAccount = "TokenAccount111111111111111111111111111111";
    const keys = [
      LEADER_A,
      PROGRAM_IDS.JUPITER_V6,
      PROGRAM_IDS.TOKEN,
      tokenAccount,
    ];
    const update = {
      transaction: {
        slot: "440700100",
        transaction: {
          signatures: [
            bs58.decode(
              "26t1fGocdKT3q7WqRJoxb8moj1f9tPXuvxLQkmabMQ2Q2tFXhesRGpDCT5AyukNubBkZzXbYKaZ1xphDHkbSUDjE",
            ),
          ],
          message: {
            versioned: true,
            header: {
              numRequiredSignatures: 1,
              numReadonlySignedAccounts: 0,
              numReadonlyUnsignedAccounts: 2,
            },
            accountKeys: keys.map((key) => bs58.decode(key)),
            addressTableLookups: [{}],
            instructions: [
              {
                programIdIndex: 1,
                accounts: Uint8Array.from([0, 3]),
                data: Uint8Array.from([1]),
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: "5000",
          preBalances: ["10000000000", "1", "1", "2039280", "1"],
          postBalances: ["8999995000", "1", "1", "2039280", "1"],
          loadedWritableAddresses: [
            bs58.decode("LookupAddress1111111111111111111111111111"),
          ],
          loadedReadonlyAddresses: [],
          preTokenBalances: [
            {
              accountIndex: 3,
              mint: TOKEN_MINT,
              owner: LEADER_A,
              uiTokenAmount: { amount: "0", decimals: 6 },
              programId: PROGRAM_IDS.TOKEN,
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 3,
              mint: TOKEN_MINT,
              owner: LEADER_A,
              uiTokenAmount: { amount: "2000000", decimals: 6 },
              programId: PROGRAM_IDS.TOKEN,
            },
          ],
          innerInstructions: [
            {
              index: 0,
              instructions: [
                {
                  programIdIndex: 1,
                  accounts: Uint8Array.from([0, 3]),
                  data: Uint8Array.from([2]),
                  stackHeight: 2,
                },
              ],
            },
          ],
          logMessages: ["Program log: Instruction: Route"],
        },
      },
    };
    const mapped = mapYellowstoneTransaction(update, {
      wallMs: 1234,
      monotonicNs: 5678n,
    });
    expect(mapped?.streamReceivedTimestampMs).toBe(1234);
    expect(mapped?.streamReceivedMonotonicNs).toBe(5678n);
    const raw = mapped?.payload as {
      version: unknown;
      accountKeys: { source: string }[];
      innerInstructions: unknown[];
    };
    expect(raw.version).toBe(0);
    expect(
      raw.accountKeys.some((key) => key.source === "LOOKUP_WRITABLE"),
    ).toBe(true);
    expect(raw.innerInstructions).toHaveLength(1);
  });
});
