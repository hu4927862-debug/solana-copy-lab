import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import PQueue from "p-queue";
import { jsonStringify } from "../domain/json.js";
import type { CapturedEvidence } from "./types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class CaptureArchive {
  private readonly queue = new PQueue({ concurrency: 1 });

  constructor(private readonly rootDirectory: string) {}

  pathFor(evidence: CapturedEvidence): string {
    const date = new Date(evidence.capturedAtMs).toISOString().slice(0, 10);
    const safeSignature =
      evidence.transaction &&
      typeof evidence.transaction === "object" &&
      "signature" in evidence.transaction
        ? String(
            (evidence.transaction as { signature: unknown }).signature,
          ).replace(/[^A-Za-z0-9_-]/g, "")
        : `unknown-${evidence.capturedAtMs}`;
    const safeLeader = evidence.leader.replace(/[^A-Za-z0-9_-]/g, "");
    return resolve(
      this.rootDirectory,
      date,
      `${safeSignature}-${safeLeader}.json.gz`,
    );
  }

  async save(evidence: CapturedEvidence): Promise<string> {
    return this.queue.add(async () => {
      const path = this.pathFor(evidence);
      await mkdir(dirname(path), { recursive: true });
      const compressed = await gzipAsync(Buffer.from(jsonStringify(evidence)), {
        level: 9,
      });
      await writeFile(path, compressed, { flag: "wx" }).catch(
        async (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
            return;
          throw error;
        },
      );
      return path;
    });
  }

  async replay(path: string): Promise<CapturedEvidence> {
    const compressed = await readFile(path);
    return JSON.parse(
      (await gunzipAsync(compressed)).toString("utf8"),
    ) as CapturedEvidence;
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
  }
}
