import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);
const safeEnvironment = {
  ...cleanEnvironment,
  PAPER_ONLY: "true",
  LIVE_FUNDS_ENABLED: "false",
  FUNDS_AUTHORIZED: "NO",
};

function git(directory: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      directory,
      ...args,
    ],
    {
      env: cleanEnvironment,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function copyOfflineDemo(directory: string): void {
  mkdirSync(directory, { recursive: true });
  // Only public source and synthetic fixture ingredients are copied. There is
  // no private state, provider configuration, wallet material or live database.
  for (const name of ["src", "migrations"]) {
    cpSync(resolve(sourceRoot, name), resolve(directory, name), {
      recursive: true,
    });
  }
  for (const name of [
    "config/risk-policy.example.json",
    "config/research/follower-strategy-verdict-policy-v1.json",
    "test/fixtures/mainnet-fixtures.ts",
    "test/helpers/envelope.ts",
    "scripts/demo-paper-workflow.ts",
    "scripts/evaluate-strategies.ts",
  ]) {
    const destination = resolve(directory, name);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(resolve(sourceRoot, name), destination);
  }
  writeFileSync(resolve(directory, "package.json"), '{"type":"module"}\n');
  writeFileSync(resolve(directory, ".gitignore"), "node_modules\n");
  // Reuse the installed dependencies without installation or network access.
  symlinkSync(
    resolve(sourceRoot, "node_modules"),
    resolve(directory, "node_modules"),
    "dir",
  );
}

function repository(): string {
  const parent = mkdtempSync(resolve(tmpdir(), "synthetic-demo-git-"));
  const directory = resolve(parent, "source");
  copyOfflineDemo(directory);
  git(directory, "init", "--initial-branch=main", "--object-format=sha1");
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=synthetic@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "SYNTHETIC offline fixture",
  );
  return directory;
}

function workflow(directory: string, environment: NodeJS.ProcessEnv = {}) {
  const outputDirectory = resolve(
    mkdtempSync(resolve(tmpdir(), "synthetic-demo-output-")),
    "new-output",
  );
  // A failure stub guards the actual child process, not a mocked revision resolver.
  const preload = resolve(dirnameOfOutput(outputDirectory), "offline-only.mjs");
  writeFileSync(
    preload,
    "globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };\n",
  );
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      preload,
      "--import",
      "tsx",
      "scripts/demo-paper-workflow.ts",
      "--output",
      outputDirectory,
    ],
    {
      cwd: directory,
      env: { ...safeEnvironment, ...environment },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output) as {
    outputDirectory: string;
    sourceRevision: string;
    evaluationRequestStatus: string;
    forbiddenEffects: {
      network: number;
      sign: number;
      send: number;
      funds: number;
    };
  };
}

function dirnameOfOutput(outputDirectory: string): string {
  return resolve(outputDirectory, "..");
}

function evaluateAndCompare(
  directory: string,
  result: ReturnType<typeof workflow>,
): void {
  const requestPath = resolve(
    result.outputDirectory,
    "EVALUATION-REQUEST.json",
  );
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  expect(request.repositoryCommit).toBe(
    git(directory, "rev-parse", "--verify", "HEAD^{commit}"),
  );
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      resolve(dirnameOfOutput(result.outputDirectory), "offline-only.mjs"),
      "--import",
      "tsx",
      "scripts/evaluate-strategies.ts",
      requestPath,
    ],
    {
      cwd: directory,
      env: safeEnvironment,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const evaluated = JSON.parse(output);
  expect(evaluated.evaluations[0].verdict.value).toBe("INSUFFICIENT_EVIDENCE");
  for (const file of ["evidence-report-v1.json", "evidence-report-v1.md"]) {
    expect(
      readFileSync(
        resolve(result.outputDirectory, "re-evaluated", file),
        "utf8",
      ),
    ).toBe(
      readFileSync(resolve(result.outputDirectory, "report", file), "utf8"),
    );
  }
  expect(result.forbiddenEffects).toEqual({
    network: 0,
    sign: 0,
    send: 0,
    funds: 0,
  });
}

describe("actual Git identity in the offline workflow CLI", () => {
  it("resolves a packed branch and generates a genuinely reusable request", () => {
    const directory = repository();
    git(directory, "pack-refs", "--all", "--prune");
    expect(existsSync(resolve(directory, ".git/refs/heads/main"))).toBe(false);
    expect(existsSync(resolve(directory, ".git/packed-refs"))).toBe(true);
    const result = workflow(directory);
    expect(result.sourceRevision).toBe(git(directory, "rev-parse", "HEAD"));
    expect(result.evaluationRequestStatus).toBe("READY");
    evaluateAndCompare(directory, result);
  });

  it("supports an actual linked worktree with a .git pointer", () => {
    const directory = repository();
    const worktree = resolve(directory, "..", "worktree");
    git(directory, "worktree", "add", "--detach", worktree, "HEAD");
    symlinkSync(
      resolve(sourceRoot, "node_modules"),
      resolve(worktree, "node_modules"),
      "dir",
    );
    expect(readFileSync(resolve(worktree, ".git"), "utf8")).toMatch(
      /^gitdir: /,
    );
    const result = workflow(worktree);
    expect(result.sourceRevision).toBe(git(worktree, "rev-parse", "HEAD"));
    expect(result.evaluationRequestStatus).toBe("READY");
    evaluateAndCompare(worktree, result);
  });

  it("keeps loose and detached HEAD identities while ignoring foreign Git environment overrides", () => {
    const directory = repository();
    const foreign = repository();
    writeFileSync(
      resolve(foreign, "FOREIGN.txt"),
      "FOREIGN SYNTHETIC SOURCE\n",
    );
    git(foreign, "add", "FOREIGN.txt");
    git(
      foreign,
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Foreign synthetic revision",
    );
    expect(git(foreign, "rev-parse", "HEAD")).not.toBe(
      git(directory, "rev-parse", "HEAD"),
    );
    const loose = workflow(directory, {
      GIT_DIR: resolve(foreign, ".git"),
      GIT_WORK_TREE: foreign,
      GIT_COMMON_DIR: resolve(foreign, ".git"),
      GIT_NAMESPACE: "foreign-namespace",
      GIT_OBJECT_DIRECTORY: resolve(foreign, ".git/objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: foreign,
    });
    expect(loose.sourceRevision).toBe(git(directory, "rev-parse", "HEAD"));
    git(directory, "checkout", "--detach", "HEAD");
    const detached = workflow(directory);
    expect(detached.sourceRevision).toBe(git(directory, "rev-parse", "HEAD"));
    expect(detached.evaluationRequestStatus).toBe("READY");
  });

  it("does not borrow an ancestor repository revision for an archive, or invent one without Git", () => {
    const parent = repository();
    const archive = resolve(parent, "nested-archive");
    copyOfflineDemo(archive);
    expect(git(archive, "rev-parse", "HEAD")).toBe(
      git(parent, "rev-parse", "HEAD"),
    );
    for (const result of [workflow(archive), workflow(parent, { PATH: "" })]) {
      expect(result.sourceRevision).toBe("UNKNOWN_SOURCE_REVISION");
      expect(result.evaluationRequestStatus).toBe(
        "SOURCE_REVISION_UNAVAILABLE",
      );
      expect(
        existsSync(resolve(result.outputDirectory, "EVALUATION-REQUEST.json")),
      ).toBe(false);
    }
  });
});
