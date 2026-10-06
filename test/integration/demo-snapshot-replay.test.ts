import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fileSystem from "node:fs";
import { fileURLToPath } from "node:url";
import { runSnapshotReplay } from "../../scripts/demo-snapshot-replay.js";

// Mock only the external filesystem boundary; classifier/normalizer stay real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("public saved snapshot replay", () => {
  it("replays the unchanged rent snapshot with exact principal and honest clocks", () => {
    const network = vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN");
    });
    vi.stubGlobal("fetch", network);
    try {
      const result = runSnapshotReplay();
      const rent = result.snapshots.find(
        (row) => row.name === "v5-native-sol-with-rent",
      );
      expect(rent).toMatchObject({
        sourceSha256:
          "023fbdcae960231ff677abf32a8385d1b5a3d3ad5b3b9d103ad0ae08af7cb04f",
        sourceFormat: "PROJECT_RAW_TRANSACTION_SNAPSHOT",
        originalRpcReceipt: "UNKNOWN",
        historicalFirstObservedAt: "UNKNOWN",
        signature:
          "2v35FAcSqvjNHq4GAfpPD5pbFbYcnrUfgYzfkDdWM6dNi9jLT6GdBgBnEvb25mKnfnfCGz1KM2JnRufuvjSjxKRz",
        chainTimeMs: 1788648703000,
        feeRaw: "10000",
        result: "ACCEPT",
        side: "BUY",
        tokenMint: "AetwReksXD7yHXm67rz9PvLbL9dGvNCbyxor2bjCpump",
        tokenRaw: "418484406419",
        quoteMint: "SOL_NATIVE",
        quoteRaw: "5000000",
        walletNativeDeltaRaw: "-6907234",
        ownerEqualsFeePayer: true,
        tokenDecimals: 6,
        quoteDecimals: 9,
      });
      expect(rent?.replayedAtMs).toBeGreaterThan(1788648703000);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves all four exact amounts, direction and fixture identities", () => {
    expect(runSnapshotReplay().snapshots).toMatchObject([
      {
        name: "v5-native-sol-with-rent",
        side: "BUY",
        tokenMint: "AetwReksXD7yHXm67rz9PvLbL9dGvNCbyxor2bjCpump",
        tokenRaw: "418484406419",
        quoteMint: "SOL_NATIVE",
        quoteRaw: "5000000",
        feeRaw: "10000",
      },
      {
        name: "v5-jupiter-buy-with-refund",
        side: "BUY",
        tokenMint: "9QQsRq3a7hL8QcJ8ZDcL943octYksy7HApmnXZoBpump",
        tokenRaw: "52614039669334",
        quoteMint: "SOL_NATIVE",
        quoteRaw: "997037",
        feeRaw: "10000",
        sourceSha256:
          "6f95656017d8b847382802f7a10c25314151bbcaeab28fc7cd904a48d4b25626",
      },
      {
        name: "v5-jupiter-sell-with-output-fee",
        side: "SELL",
        tokenMint: "6So7vYgRXTF33wWQKp62WEQggtjCY7HifXLG2TG2pump",
        tokenRaw: "21178399997852",
        quoteMint: "SOL_NATIVE",
        quoteRaw: "7816843",
        feeRaw: "10000",
        sourceSha256:
          "e90b8ab14dc5ed559d3f0b317609bb2521d4ba143c966f67d6c789a4cf288bbb",
      },
      {
        name: "v5-jupiter-full-sell-with-output-fee",
        side: "SELL",
        tokenMint: "KvrGrrM115pmRbXX9D8AS8XS2XQXhZqLcCEsAyYpump",
        tokenRaw: "944791432947",
        quoteMint: "SOL_NATIVE",
        quoteRaw: "1230294",
        feeRaw: "10000",
        sourceSha256:
          "63abc340cfb355d7742a918b2b1de3dd55b4ca072d227ad25d21958a75a27a24",
      },
    ]);
  });

  it("retains derived missing-proof and wrong-owner cases as rejected", () => {
    expect(runSnapshotReplay().negativeControls).toMatchObject([
      {
        name: "missing-native-transfer-proof",
        evidenceKind: "SYNTHETIC_MUTATION",
        result: "REJECT",
        code: "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
      },
      {
        name: "wrong-explicit-owner",
        evidenceKind: "SYNTHETIC_CALLER",
        result: "REJECT",
        code: "LEADER_NOT_SIGNER",
      },
    ]);
  });

  it("fails closed for changed source bytes before classifying them", () => {
    const read = vi
      .mocked(fileSystem.readFileSync)
      .mockReturnValueOnce(Buffer.from("tampered snapshot"));
    try {
      expect(() => runSnapshotReplay()).toThrow(
        "SNAPSHOT_HASH_MISMATCH:v5-native-sol-with-rent",
      );
    } finally {
      read.mockRestore();
    }
  });

  it("prints a self-contained JSON replay through the actual CLI", () => {
    const text = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/demo-snapshot-replay.ts"],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const output = JSON.parse(text);
    expect(output.schema).toBe("OFFLINE_SNAPSHOT_REPLAY_V1");
    expect(output.snapshots).toHaveLength(4);
    expect(output.negativeControls).toHaveLength(2);
    expect(output.fundsAuthorized).toBe(false);
    expect(
      output.snapshots.every(
        (row: {
          historicalFirstObservedAt: string;
          originalRpcReceipt: string;
        }) =>
          row.historicalFirstObservedAt === "UNKNOWN" &&
          row.originalRpcReceipt === "UNKNOWN",
      ),
    ).toBe(true);
  });
});
