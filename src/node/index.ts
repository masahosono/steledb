/**
 * Node.js 専用ヘルパー。fs からの JSON ロードと CI 向け検証ランナーを提供する。
 * コア（fs 非依存）とはエントリポイントを分離しており、`jsonrdb/node` から import する。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { JsonRdbError, formatErrors } from "../errors.js";
import type { Schema, SchemaTables, TablesData } from "../schema.js";
import { type ValidateOptions, type ValidationResult, validate } from "../validate.js";

export interface LoadTablesOptions {
  /**
   * テーブルキー → ファイル名の写像。省略時は `<テーブルキー>.json`。
   * kebab-case のファイル名（例: digital-singles.json）はここで対応付ける。
   */
  readonly fileFor?: (tableKey: string) => string;
}

function toDirPath(dir: string | URL): string {
  return typeof dir === "string" ? dir : fileURLToPath(dir);
}

/**
 * ディレクトリ内の JSON ファイル群をスキーマの全テーブル分ロードする。
 * ファイル欠落・JSON パース失敗・トップレベル非配列は具体的なメッセージで throw。
 */
export async function loadTablesFromDir<S extends SchemaTables>(
  dir: string | URL,
  schema: Schema<S>,
  options: LoadTablesOptions = {},
): Promise<TablesData<S>> {
  const fileFor = options.fileFor ?? ((tableKey: string) => `${tableKey}.json`);
  const dirPath = toDirPath(dir);
  const data: Record<string, readonly unknown[]> = {};
  for (const tableKey of schema._.tables.keys()) {
    const path = join(dirPath, fileFor(tableKey));
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (cause) {
      throw new JsonRdbError(`テーブル "${tableKey}" のファイルが読めません: ${path}`, { cause });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new JsonRdbError(`${path} の JSON パースに失敗しました: ${String(cause)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new JsonRdbError(`${path} のトップレベルが配列ではありません`);
    }
    data[tableKey] = parsed;
  }
  return data as TablesData<S>;
}

export interface IntegrityCheckOptions<S extends SchemaTables> {
  readonly schema: Schema<S>;
  /** JSON ディレクトリからロードする場合に指定（data と排他） */
  readonly dataDir?: string | URL;
  /** ロード済みデータを直接渡す場合に指定（dataDir と排他） */
  readonly data?: TablesData<S>;
  readonly fileFor?: (tableKey: string) => string;
  readonly validateOptions?: ValidateOptions;
  /** 正常時の出力先（デフォルト console.log） */
  readonly log?: (line: string) => void;
  /** エラー時の出力先（デフォルト console.error） */
  readonly error?: (line: string) => void;
}

/**
 * データ整合性チェックの CI 用ランナー。エラーを全件列挙して
 * `process.exitCode = 1` を設定し、正常時は件数サマリを出力する。
 * 利用側は check スクリプトからこれを呼ぶだけでよい:
 *
 * ```ts
 * // scripts/check-data.ts
 * import { runIntegrityCheck } from "jsonrdb/node";
 * import { schema } from "../src/db/schema.ts";
 * await runIntegrityCheck({ schema, dataDir: new URL("../src/data/", import.meta.url) });
 * ```
 */
export async function runIntegrityCheck<S extends SchemaTables>(
  options: IntegrityCheckOptions<S>,
): Promise<ValidationResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

  let data: TablesData<S>;
  if (options.data !== undefined) {
    data = options.data;
  } else if (options.dataDir !== undefined) {
    data = await loadTablesFromDir(
      options.dataDir,
      options.schema,
      options.fileFor === undefined ? {} : { fileFor: options.fileFor },
    );
  } else {
    throw new JsonRdbError("runIntegrityCheck には data か dataDir のどちらかを指定してください");
  }

  const result = validate(options.schema, data, options.validateOptions);
  if (result.ok) {
    const dataRecord = data as Readonly<Record<string, readonly unknown[]>>;
    const summary = [...options.schema._.tables.keys()]
      .map((tableKey) => `${tableKey}: ${dataRecord[tableKey]?.length ?? 0}`)
      .join(" / ");
    log("✅ データ整合性 OK");
    log(`  ${summary}`);
  } else {
    error(formatErrors(result.errors));
    process.exitCode = 1;
  }
  return result;
}
