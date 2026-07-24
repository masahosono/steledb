import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDb } from "../db.js";
import { catalogSchema, cloneValidData, validData } from "../testing/catalog-schema.js";
import { loadTablesFromDir, runIntegrityCheck } from "./index.js";

let dir: string;

async function writeTables(
  targetDir: string,
  data: Readonly<Record<string, readonly unknown[]>>,
  rename: Readonly<Record<string, string>> = {},
): Promise<void> {
  for (const [tableKey, rows] of Object.entries(data)) {
    const fileName = rename[tableKey] ?? `${tableKey}.json`;
    await writeFile(join(targetDir, fileName), JSON.stringify(rows, null, 2), "utf-8");
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "steledb-test-"));
  await writeTables(dir, validData);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("loadTablesFromDir", () => {
  test("loads every table of the schema from a directory", async () => {
    const data = await loadTablesFromDir(dir, catalogSchema);
    expect(data).toEqual(validData);
    // the result can be handed straight to createDb
    const db = createDb(catalogSchema, data);
    expect(db.get(catalogSchema.songs, "s1")?.title).toBe("Deep Blue");
  });

  test("fileFor handles kebab-case and other file names", async () => {
    const kebabDir = await mkdtemp(join(tmpdir(), "steledb-kebab-"));
    try {
      await writeTables(kebabDir, validData, { setlists: "set-lists.json" });
      const data = await loadTablesFromDir(kebabDir, catalogSchema, {
        fileFor: (tableKey) => (tableKey === "setlists" ? "set-lists.json" : `${tableKey}.json`),
      });
      expect(data.setlists).toEqual(validData.setlists);
    } finally {
      await rm(kebabDir, { recursive: true, force: true });
    }
  });

  test("a missing file throws with the table key and the path", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "steledb-empty-"));
    try {
      await expect(loadTablesFromDir(emptyDir, catalogSchema)).rejects.toThrow(
        /cannot read the file for table "artists"/,
      );
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("a non-JSON file or a non-array top level throws", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "steledb-bad-"));
    try {
      await writeTables(badDir, validData);
      await writeFile(join(badDir, "artists.json"), "{not json", "utf-8");
      await expect(loadTablesFromDir(badDir, catalogSchema)).rejects.toThrow(
        /failed to parse the JSON/,
      );

      await writeFile(join(badDir, "artists.json"), '{"id": "a1"}', "utf-8");
      await expect(loadTablesFromDir(badDir, catalogSchema)).rejects.toThrow(
        /top level of .* is not an array/,
      );
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });
});

describe("runIntegrityCheck", () => {
  test("valid data: leaves the exit code alone and prints a row count summary", async () => {
    const logs: string[] = [];
    const result = await runIntegrityCheck({
      schema: catalogSchema,
      dataDir: dir,
      log: (line) => logs.push(line),
      error: () => {
        throw new Error("the error output should not be called");
      },
    });
    expect(result.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(logs[0]).toContain("✅");
    expect(logs[1]).toContain("songs: 3");
    expect(logs[1]).toContain("events: 3");
  });

  test("broken data: lists every error and sets the exit code to 1", async () => {
    const data = cloneValidData();
    data.songs[0]?.artists.push({ id: "a999", name: "Missing Person" });
    data.events.push({ ...structuredClone(data.events[0]), id: "e1" } as never);

    const errors: string[] = [];
    const result = await runIntegrityCheck({
      schema: catalogSchema,
      data,
      error: (line) => errors.push(line),
      log: () => {
        throw new Error("the success output should not be called");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("2 integrity error(s)");
    expect(errors.join("\n")).toContain("artists[1].id");
  });

  test("throws when neither data nor dataDir is given", async () => {
    await expect(runIntegrityCheck({ schema: catalogSchema })).rejects.toThrow(
      /requires either data or dataDir/,
    );
  });
});
