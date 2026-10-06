import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import PQueue from "p-queue";
import * as schema from "./schema.js";

export interface DatabaseOptions {
  readonly path: string;
  readonly migrationsDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
}

export class SqliteDatabase {
  readonly path: string;
  readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;
  readonly writer = new PQueue({ concurrency: 1 });
  private readonly writeLatenciesMs: number[] = [];
  private busyErrorCount = 0;

  constructor(options: DatabaseOptions) {
    this.path = options.path;
    this.sqlite = new Database(
      options.path,
      options.readOnly ? { readonly: true, fileMustExist: true } : undefined,
    );
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    if (options.readOnly) {
      this.sqlite.pragma("query_only = ON");
    } else {
      this.sqlite.pragma("journal_mode = WAL");
      this.sqlite.pragma("synchronous = FULL");
    }
    this.orm = drizzle(this.sqlite, { schema });
    if (!options.readOnly) this.migrate(options.migrationsDirectory);
  }

  async write<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.writer.add(async () => {
      const started = performance.now();
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof Error &&
          ("code" in error
            ? String((error as Error & { code?: unknown }).code) ===
              "SQLITE_BUSY"
            : false)
        ) {
          this.busyErrorCount += 1;
        }
        throw error;
      } finally {
        this.writeLatenciesMs.push(performance.now() - started);
        if (this.writeLatenciesMs.length > 10_000)
          this.writeLatenciesMs.shift();
      }
    });
  }

  getWriterHealth(): {
    readonly queueSize: number;
    readonly pending: number;
    readonly busyErrorCount: number;
    readonly averageMs: number;
    readonly p95Ms: number;
  } {
    const sorted = [...this.writeLatenciesMs].sort(
      (left, right) => left - right,
    );
    const averageMs =
      sorted.length === 0
        ? 0
        : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const p95Ms = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    return {
      queueSize: this.writer.size,
      pending: this.writer.pending,
      busyErrorCount: this.busyErrorCount,
      averageMs,
      p95Ms,
    };
  }

  close(): void {
    this.writer.pause();
    this.sqlite.close();
  }

  private migrate(directory: string): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )
    `);

    const files = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = this.sqlite.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = ?",
    );
    const record = this.sqlite.prepare(
      "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, ?)",
    );

    for (const file of files) {
      const sql = readFileSync(resolve(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = applied.get(file) as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration checksum mismatch: ${file}`);
        }
        continue;
      }
      this.sqlite.transaction(() => {
        this.sqlite.exec(sql);
        record.run(file, checksum, Date.now());
      })();
    }
  }
}
