import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDb } from "../db.js";
import { cloneValidData, catalogSchema, validData } from "../testing/catalog-schema.js";
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
  dir = await mkdtemp(join(tmpdir(), "jsonrdb-test-"));
  await writeTables(dir, validData);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("loadTablesFromDir", () => {
  test("スキーマの全テーブルをディレクトリからロードできる", async () => {
    const data = await loadTablesFromDir(dir, catalogSchema);
    expect(data).toEqual(validData);
    // そのまま createDb に流せる
    const db = createDb(catalogSchema, data);
    expect(db.get(catalogSchema.songs, "s1")?.title).toBe("Deep Blue");
  });

  test("fileFor で kebab-case 等のファイル名に対応できる", async () => {
    const kebabDir = await mkdtemp(join(tmpdir(), "jsonrdb-kebab-"));
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

  test("ファイルが無ければテーブルキーとパスつきで throw", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "jsonrdb-empty-"));
    try {
      await expect(loadTablesFromDir(emptyDir, catalogSchema)).rejects.toThrow(
        /テーブル "artists" のファイルが読めません/,
      );
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("JSON でないファイルやトップレベル非配列は throw", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "jsonrdb-bad-"));
    try {
      await writeTables(badDir, validData);
      await writeFile(join(badDir, "artists.json"), "{not json", "utf-8");
      await expect(loadTablesFromDir(badDir, catalogSchema)).rejects.toThrow(/JSON パースに失敗/);

      await writeFile(join(badDir, "artists.json"), '{"id": "a1"}', "utf-8");
      await expect(loadTablesFromDir(badDir, catalogSchema)).rejects.toThrow(
        /トップレベルが配列ではありません/,
      );
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });
});

describe("runIntegrityCheck", () => {
  test("正常データ: exit code を触らず件数サマリを出力する", async () => {
    const logs: string[] = [];
    const result = await runIntegrityCheck({
      schema: catalogSchema,
      dataDir: dir,
      log: (line) => logs.push(line),
      error: () => {
        throw new Error("エラー出力は呼ばれないはず");
      },
    });
    expect(result.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(logs[0]).toContain("✅");
    expect(logs[1]).toContain("songs: 3");
    expect(logs[1]).toContain("events: 3");
  });

  test("壊れたデータ: 全件列挙して exit code 1 を設定する", async () => {
    const data = cloneValidData();
    data.songs[0]?.artists.push({ id: "a999", name: "存在しない人" });
    data.events.push({ ...structuredClone(data.events[0]), id: "e1" } as never);

    const errors: string[] = [];
    const result = await runIntegrityCheck({
      schema: catalogSchema,
      data,
      error: (line) => errors.push(line),
      log: () => {
        throw new Error("正常出力は呼ばれないはず");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("2 件の整合性エラー");
    expect(errors.join("\n")).toContain("artists[1].id");
  });

  test("data も dataDir も無ければ throw", async () => {
    await expect(runIntegrityCheck({ schema: catalogSchema })).rejects.toThrow(
      /data か dataDir のどちらか/,
    );
  });
});
