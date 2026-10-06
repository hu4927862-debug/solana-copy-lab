import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureArchive } from "../../src/validation/capture-archive.js";
import { MAINNET_FIXTURES, LEADER_A } from "../fixtures/mainnet-fixtures.js";

describe("CaptureArchive", () => {
  it("stores deterministic compressed evidence and replays it offline", async () => {
    const archive = new CaptureArchive(
      mkdtempSync(resolve(tmpdir(), "archive-")),
    );
    const evidence = {
      captureVersion: 1 as const,
      capturedAtMs: 1_730_000_000_000,
      provider: "primary",
      leader: LEADER_A,
      transaction: MAINNET_FIXTURES.jupiterBuy,
      systemClassification: "BUY" as const,
      groundTruth: {
        classification: "BUY" as const,
        source: "AUTO_RULE" as const,
      },
    };
    const first = await archive.save(evidence);
    const second = await archive.save(evidence);
    expect(second).toBe(first);
    const replayed = await archive.replay(first);
    expect((replayed.transaction as { signature: string }).signature).toBe(
      MAINNET_FIXTURES.jupiterBuy.signature,
    );
  });
});
