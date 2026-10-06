import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { jsonStringify } from "../domain/json.js";
import { LiveEvaluator } from "./evaluator.js";

export class LiveReportGenerator {
  constructor(
    private readonly evaluator: LiveEvaluator,
    private readonly reportDirectory: string,
    private readonly options: {
      readonly streamProvider?: "QUICKNODE_WEBSOCKET" | "YELLOWSTONE";
    } = {},
  ) {}

  async generate(): Promise<void> {
    await mkdir(this.reportDirectory, { recursive: true });
    const accuracy = this.evaluator.accuracy();
    const counts = this.evaluator.counts();
    const providerLatency = this.evaluator.providerLatency();
    const pipelineLatency = this.evaluator.latency();
    const jupiterLatency = this.evaluator.jupiterLatency();
    const falsePositives = this.evaluator.falsePositives();
    const falseNegatives = this.evaluator.falseNegatives();
    const recovery = this.evaluator.recovery();
    const observed = Number(
      (counts as { totalObservedTransactions?: unknown })
        .totalObservedTransactions ?? 0,
    );
    const summary = {
      generatedAt: new Date().toISOString(),
      phase: "LIVE_SHADOW_MAINNET_SOAK_VALIDATION",
      stream_provider: this.options.streamProvider ?? "UNKNOWN",
      liveFundsEnabled: false,
      validationStatus:
        observed > 0 ? "LIVE_DATA_COLLECTED" : "NO_LIVE_OBSERVATIONS",
      groundTruthWarning: "AUTO_RULE labels are provisional until human review",
      counts,
      accuracy: accuracy.overall,
      dexAccuracy: accuracy.byDex,
      providerLatency,
      pipelineLatency,
      jupiterLatency,
      theoreticalCopyPerformance: this.evaluator.theoreticalPerformance(),
      sqliteSoak: this.evaluator.soak(),
      recovery,
    };
    await Promise.all([
      this.writeJson("live-shadow-summary.json", summary),
      this.writeJson("provider-latency.json", providerLatency),
      this.writeJson("dex-accuracy.json", accuracy.byDex),
      this.writeJson("false-positives.json", falsePositives),
      this.writeJson("false-negatives.json", falseNegatives),
      this.writeJson("jupiter-latency.json", jupiterLatency),
      this.writeJson("recovery-tests.json", recovery),
      writeFile(
        resolve(this.reportDirectory, "live-shadow-summary.md"),
        this.markdown(summary),
        "utf8",
      ),
    ]);
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await writeFile(
      resolve(this.reportDirectory, name),
      `${jsonStringify(value, 2)}\n`,
      "utf8",
    );
  }

  private markdown(summary: Record<string, unknown>): string {
    const counts = summary.counts as Record<string, unknown>;
    const accuracy = summary.accuracy as Record<string, unknown>;
    const latency = summary.pipelineLatency as Record<
      string,
      { p50: unknown; p95: unknown; p99: unknown }
    >;
    const row = (label: string, value: unknown) =>
      `| ${label} | ${value ?? "N/A"} |`;
    return [
      "# Live Shadow Validation Summary",
      "",
      `Generated: ${String(summary.generatedAt)}`,
      `Stream provider: ${String(summary.stream_provider)}`,
      "",
      "> Safety: paper/shadow only. No signer, `/execute`, `sendTransaction`, or real swap is present.",
      "",
      "## Counts",
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      ...Object.entries(counts).map(([key, value]) => row(key, value)),
      "",
      "## Accuracy",
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      row("Precision", accuracy.precision),
      row("Recall", accuracy.recall),
      row("F1", accuracy.f1),
      row(
        "Human-reviewed labels",
        (accuracy.groundTruth as Record<string, unknown>).humanReviewed,
      ),
      row(
        "Provisional auto-rule labels",
        (accuracy.groundTruth as Record<string, unknown>).provisionalAutoRule,
      ),
      "",
      "## Live pipeline latency (ms)",
      "",
      "| Stage | P50 | P95 | P99 |",
      "| --- | ---: | ---: | ---: |",
      ...Object.entries(latency).map(
        ([key, value]) =>
          `| ${key} | ${value.p50 ?? "N/A"} | ${value.p95 ?? "N/A"} | ${value.p99 ?? "N/A"} |`,
      ),
      "",
      "Accuracy based only on AUTO_RULE labels is provisional; review queue completion is required for a defensible gate.",
      "",
    ].join("\n");
  }
}
