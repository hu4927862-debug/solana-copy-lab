import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPaperWorkflow } from "../../scripts/demo-paper-workflow.js";
import * as riskPolicyModule from "../../src/risk/risk-policy.js";

describe("public synthetic paper workflow", () => {
  it("connects classification, original risk and paper accounting without network", async () => {
    const network = vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN");
    });
    vi.stubGlobal("fetch", network);
    try {
      const result = await runPaperWorkflow();
      expect(network).not.toHaveBeenCalled();
      expect(result.summary).toMatchObject({
        mode: "SYNTHETIC_OFFLINE_PAPER",
        inputs: 7,
        syntheticQuoteRequests: 4,
        paperFills: 2,
        duplicateEvents: 1,
        verdict: "INSUFFICIENT_EVIDENCE",
        forbiddenEffects: { network: 0, sign: 0, send: 0, funds: 0 },
        position: {
          quantityRaw: "0",
          status: "CLOSED",
          realizedPnlQuoteRaw: "1000000",
        },
      });
      const cases = result.summary.cases;
      expect(
        cases.map((item) => [item.name, item.result, item.quoteRequests]),
      ).toEqual([
        ["paper-buy", "PAPER_EXECUTED", 1],
        ["duplicate-buy", "DUPLICATE_EVENT", 0],
        ["high-impact-buy", "PRICE_IMPACT_TOO_HIGH", 1],
        ["missing-impact-buy", "PRICE_IMPACT_UNAVAILABLE", 1],
        ["stale-buy", "STALE_INTENT", 0],
        ["ordinary-transfer", "ORDINARY_TRANSFER", 0],
        ["paper-full-sell", "PAPER_EXECUTED", 1],
      ]);
      expect(cases.at(-1)?.inputRaw).toBe("9007199254740993");
      expect(cases[0]?.outputRaw).toBe("9007199254740993");
      const manifest = JSON.parse(
        readFileSync(resolve(result.outputDirectory, "MANIFEST.json"), "utf8"),
      );
      for (const item of manifest.files) {
        expect(
          createHash("sha256")
            .update(readFileSync(resolve(result.outputDirectory, item.path)))
            .digest("hex"),
        ).toBe(item.sha256);
      }
      const artifactFiles = [
        ...readdirSync(result.outputDirectory).filter(
          (name) => name !== "MANIFEST.json" && name !== "report",
        ),
        ...readdirSync(resolve(result.outputDirectory, "report")).map(
          (name) => `report/${name}`,
        ),
      ].sort();
      expect(
        manifest.files.map((item: { path: string }) => item.path).sort(),
      ).toEqual(artifactFiles);
      expect(readFileSync(result.report.jsonPath, "utf8")).toBe(
        result.report.json,
      );
      expect(result.report.report.evaluations[0]?.verdict.value).toBe(
        "INSUFFICIENT_EVIDENCE",
      );
      expect(existsSync(resolve(result.outputDirectory, "paper.sqlite"))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses an existing output directory without overwriting its contents", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "existing-paper-demo-"));
    await expect(
      runPaperWorkflow({ outputDirectory: directory }),
    ).rejects.toThrow("OUTPUT_DIRECTORY_ALREADY_EXISTS");
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each([
    ["PAPER_ONLY", "false"],
    ["LIVE_FUNDS_ENABLED", "true"],
    ["FUNDS_AUTHORIZED", "YES"],
  ])(
    "rejects explicit live authority %s before any artifact is created",
    async (name, value) => {
      const parent = mkdtempSync(resolve(tmpdir(), "unsafe-paper-demo-"));
      const outputDirectory = resolve(parent, "should-not-exist");
      vi.stubEnv(name, value);
      try {
        await expect(runPaperWorkflow({ outputDirectory })).rejects.toThrow(
          "SYNTHETIC_PAPER_SAFETY_CONFIG_INVALID",
        );
        expect(existsSync(outputDirectory)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("restores the caller environment when initialization fails", async () => {
    vi.stubEnv("PAPER_ONLY", undefined);
    vi.stubEnv("LIVE_FUNDS_ENABLED", undefined);
    const parse = vi
      .spyOn(riskPolicyModule, "parseRiskPolicy")
      .mockImplementationOnce(() => {
        throw new Error("SYNTHETIC_POLICY_READ_FAILURE");
      });
    try {
      await expect(runPaperWorkflow()).rejects.toThrow(
        "SYNTHETIC_POLICY_READ_FAILURE",
      );
      expect(process.env.PAPER_ONLY).toBeUndefined();
      expect(process.env.LIVE_FUNDS_ENABLED).toBeUndefined();
    } finally {
      parse.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
