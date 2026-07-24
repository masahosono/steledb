import { spawnSync } from "node:child_process";
/**
 * End-to-end tests for the CLI. They run the built dist/cli/main.js as a child
 * process and inspect the exit code, stdout and stderr. beforeAll builds first
 * when it has to, so a bare `npm run test` sets itself up automatically.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = join(REPO_ROOT, "dist/cli/main.js");
const DIST_INDEX = join(REPO_ROOT, "dist/index.js");

function runCli(args: readonly string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: "utf-8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

let workDir: string;
let schemaPath: string;
let okDir: string;
let ngDir: string;

function schemaSource(): string {
  return `import { defineSchema, t, table } from ${JSON.stringify(DIST_INDEX)};

const authors = table("authors", {
  id: t.string().primaryKey(),
  name: t.string(),
});

const books = table("books", {
  id: t.string().primaryKey(),
  title: t.string(),
  authorId: t.string().references(() => authors.id),
});

export const schema = defineSchema({ authors, books });
export const named = schema;
`;
}

beforeAll(() => {
  if (!existsSync(CLI_ENTRY) || !existsSync(DIST_INDEX)) {
    const buildResult = spawnSync("npm", ["run", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "inherit",
    });
    if (buildResult.status !== 0) {
      throw new Error("dist was missing, and the build attempted in its place failed");
    }
  }

  workDir = mkdtempSync(join(tmpdir(), "steledb-cli-test-"));
  schemaPath = join(workDir, "schema.ts");
  writeFileSync(schemaPath, schemaSource());

  okDir = join(workDir, "data-ok");
  ngDir = join(workDir, "data-ng");
  mkdirSync(okDir, { recursive: true });
  mkdirSync(ngDir, { recursive: true });

  const write = (dir: string, name: string, value: unknown) => {
    writeFileSync(join(dir, name), JSON.stringify(value));
  };
  write(okDir, "authors.json", [
    { id: "a1", name: "Ada Lowell" },
    { id: "a2", name: "Miles Vane" },
  ]);
  write(okDir, "books.json", [
    { id: "b1", title: "T1", authorId: "a1" },
    { id: "b2", title: "T2", authorId: "a2" },
  ]);
  write(ngDir, "authors.json", [{ id: "a1", name: "Ada Lowell" }]);
  write(ngDir, "books.json", [
    { id: "b1", title: "T1", authorId: "a1" },
    { id: "b2", title: "T2", authorId: "a999" },
  ]);
});

afterAll(() => {
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("the steledb CLI", () => {
  test("help prints the help and exits 0", () => {
    const r = runCli(["help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("steledb check");
  });

  test("no subcommand prints the help and exits 2", () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("Usage:");
  });

  test("an unknown subcommand exits 2", () => {
    const r = runCli(["nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "nope"');
  });

  test("check: valid data exits 0 with a row count summary", () => {
    const r = runCli(["check", "--schema", schemaPath, "--data", okDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("data integrity OK");
    expect(r.stdout).toContain("authors: 2");
    expect(r.stdout).toContain("books: 2");
  });

  test("check: inconsistent data exits 1 with an error message", () => {
    const r = runCli(["check", "--schema", schemaPath, "--data", ngDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("integrity error");
    expect(r.stderr).toContain("a999");
  });

  test("check: the --json flag exits 1 and writes JSON to stdout", () => {
    const r = runCli(["check", "--schema", schemaPath, "--data", ngDir, "--json"]);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; errors: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test("check: --export selects an alternative export name", () => {
    const r = runCli(["check", "--schema", schemaPath, "--data", okDir, "--export", "named"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("data integrity OK");
  });

  test("check: omitting --schema exits 2", () => {
    const r = runCli(["check", "--data", okDir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--schema");
  });

  test("check: omitting --data exits 2", () => {
    const r = runCli(["check", "--schema", schemaPath]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--data");
  });

  test("check: a nonexistent --export is an error and exits 1", () => {
    const r = runCli([
      "check",
      "--schema",
      schemaPath,
      "--data",
      okDir,
      "--export",
      "does_not_exist",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('export "does_not_exist" not found');
  });

  test("check: a nonexistent schema file is an error and exits 1", () => {
    const r = runCli(["check", "--schema", join(workDir, "nope.ts"), "--data", okDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot load the schema file");
  });
});
