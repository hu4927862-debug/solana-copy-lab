import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { runOfflineReviewDemo } from "../../scripts/demo-review-offline.js";

describe("public pure offline transaction review", () => {
  it("checks actual guards against synthetic bytes and retains the missing-evidence block", async () => {
    const network = vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN");
    });
    vi.stubGlobal("fetch", network);
    const sign = vi.spyOn(crypto, "sign").mockImplementation(() => {
      throw new Error("SIGN_FORBIDDEN");
    });
    try {
      const result = await runOfflineReviewDemo();
      expect(result.evidence).toBe("SYNTHETIC_OFFLINE_GUARD_CHECK");
      expect(result.cases.map(({ name, actual }) => [name, actual])).toEqual([
        ["missing-cpi-evidence", "CPI_EVIDENCE_REQUIRED"],
        ["wrong-wallet", "UNEXPECTED_SIGNER_OR_PRE_SIGNATURE"],
        ["unexpected-program", "UNSUPPORTED_OUTER_PROGRAM"],
        ["wrong-route-account", "ROUTE_ACCOUNT_SCOPE"],
        ["wrong-amount", "ROUTE_AMOUNT_SCOPE"],
        ["excessive-slippage", "ROUTE_FEE_OR_SLIPPAGE_SCOPE"],
        ["network-fee-over-budget", "NETWORK_FEE_CAP"],
        ["changed-message-at-signature-intake", "SIGNER_CHANGED_TRANSACTION"],
        ["absent-signature-at-intake", "MISSING_SIGNATURE"],
      ]);
      expect(
        result.cases.every(({ result }) => result === "EXPECTED_BLOCK"),
      ).toBe(true);
      expect(result.lookupCalls).toBe(0);
      expect(result.completeTransactionReview).toBe(
        "NOT_PASSED_MISSING_CPI_EVIDENCE",
      );
      expect(result.forbiddenEffects).toEqual({
        network: 0,
        liveBuild: 0,
        onchainSimulation: 0,
        sign: 0,
        send: 0,
        funds: 0,
      });
      expect(network).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    } finally {
      sign.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
