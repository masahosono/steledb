import type { ColumnDef } from "./column.js";
import {
  JsonRdbError,
  type ValidationError,
  type ValidationErrorBase,
  formatErrorPath,
} from "./errors.js";
import type { Schema, SchemaTables, TablesData } from "./schema.js";
import type { AnyTable } from "./table.js";

export interface ValidateOptions {
  /**
   * スキーマに無いキーの扱い。デフォルト "error"。
   * 手書きデータの typo や、AI による勝手なフィールド追加の検出に有効。
   */
  readonly unknownKeys?: "error" | "ignore";
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

type ErrorPayload =
  | { code: "SHAPE_MISMATCH"; expected: string; actual: unknown }
  | { code: "UNKNOWN_KEY"; key: string }
  | { code: "DUPLICATE_KEY"; column: string; value: unknown; otherRowIndex: number }
  | { code: "FK_VIOLATION"; value: unknown; refTable: string; refColumn: string }
  | {
      code: "DENORMALIZED_MISMATCH";
      actual: unknown;
      expected: unknown;
      allowedAliases?: readonly unknown[];
      refTable: string;
      refKeyPath: string;
    }
  | { code: "SCOPED_DUPLICATE"; scopePath: string; key: readonly unknown[] }
  | { code: "CHECK_FAILED"; detail: string };

/** 値をエラーメッセージ用に短く表示する */
function show(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

function describeType(def: ColumnDef): string {
  let base: string;
  switch (def.kind) {
    case "enum":
      base = `enum(${(def.enumValues ?? []).join(" | ")})`;
      break;
    default:
      base = def.kind;
  }
  return def.nullable ? `${base} | null` : base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** テーブル 1 つ分の検証コンテキスト。行の特定情報の生成とエラー収集を担う。 */
class TableValidator {
  readonly tableKey: string;
  readonly table: AnyTable;
  readonly rows: readonly unknown[];
  readonly pkColumn: string | null;
  readonly unknownKeys: "error" | "ignore";
  private readonly sink: ValidationError[];

  constructor(
    tableKey: string,
    table: AnyTable,
    rows: readonly unknown[],
    pkColumn: string | null,
    unknownKeys: "error" | "ignore",
    sink: ValidationError[],
  ) {
    this.tableKey = tableKey;
    this.table = table;
    this.rows = rows;
    this.pkColumn = pkColumn;
    this.unknownKeys = unknownKeys;
    this.sink = sink;
  }

  rowKeyOf(row: unknown): string | number | null {
    if (this.pkColumn === null || !isPlainObject(row)) return null;
    const value = row[this.pkColumn];
    return typeof value === "string" || typeof value === "number" ? value : null;
  }

  rowLabelOf(row: unknown, rowIndex: number): string {
    const displayAs = this.table._.config.displayAs;
    if (displayAs) {
      try {
        return displayAs(row);
      } catch {
        // shape が壊れた行では displayAs が失敗しうるのでフォールバックへ
      }
    }
    const rowKey = this.rowKeyOf(row);
    return rowKey !== null ? `(${this.pkColumn}=${rowKey})` : `(行 ${rowIndex})`;
  }

  addError(
    rowIndex: number,
    path: readonly (string | number)[],
    message: string,
    payload: ErrorPayload,
  ): void {
    const row = this.rows[rowIndex];
    const base: ValidationErrorBase = {
      table: this.tableKey,
      rowIndex,
      rowKey: this.rowKeyOf(row),
      rowLabel: this.rowLabelOf(row, rowIndex),
      path,
      pathString: formatErrorPath(path),
      message,
    };
    this.sink.push({ ...base, ...payload } as ValidationError);
  }

  /** 全行の shape を検証し、行ごとの合否を返す（壊れた行は関係検証をスキップする） */
  validateShape(): boolean[] {
    return this.rows.map((row, rowIndex) => {
      if (!isPlainObject(row)) {
        this.addError(rowIndex, [], `行がオブジェクトではありません（実際: ${show(row)}）`, {
          code: "SHAPE_MISMATCH",
          expected: "object",
          actual: row,
        });
        return false;
      }
      return this.checkObject(rowIndex, this.table._.shape, row, []);
    });
  }

  private checkValue(
    rowIndex: number,
    def: ColumnDef,
    value: unknown,
    path: readonly (string | number)[],
  ): boolean {
    if (value === null) {
      if (def.nullable) return true;
      this.addError(rowIndex, path, `null は許可されていません（期待: ${describeType(def)}）`, {
        code: "SHAPE_MISMATCH",
        expected: describeType(def),
        actual: null,
      });
      return false;
    }

    switch (def.kind) {
      case "string":
      case "number":
      case "boolean": {
        if (typeof value === def.kind) return true;
        this.mismatch(rowIndex, def, value, path);
        return false;
      }
      case "enum": {
        if (typeof value === "string" && (def.enumValues ?? []).includes(value)) return true;
        this.addError(
          rowIndex,
          path,
          `許可されていない値です（期待: ${describeType(def)}、実際: ${show(value)}）`,
          { code: "SHAPE_MISMATCH", expected: describeType(def), actual: value },
        );
        return false;
      }
      case "array": {
        if (!Array.isArray(value)) {
          this.mismatch(rowIndex, def, value, path);
          return false;
        }
        const element = def.element;
        if (element === undefined) return true;
        let ok = true;
        value.forEach((item, index) => {
          ok = this.checkValue(rowIndex, element, item, [...path, index]) && ok;
        });
        return ok;
      }
      case "object": {
        if (!isPlainObject(value)) {
          this.mismatch(rowIndex, def, value, path);
          return false;
        }
        return this.checkObject(rowIndex, def.shape ?? {}, value, path);
      }
    }
  }

  private checkObject(
    rowIndex: number,
    shape: Readonly<Record<string, ColumnDef>>,
    obj: Record<string, unknown>,
    path: readonly (string | number)[],
  ): boolean {
    let ok = true;
    for (const [key, childDef] of Object.entries(shape)) {
      // JSON に undefined は存在しないため「キーが無い」と「undefined 値」は同一視する
      if (!(key in obj) || obj[key] === undefined) {
        if (childDef.optional) continue;
        this.addError(
          rowIndex,
          [...path, key],
          `必須キーがありません（期待: ${describeType(childDef)}）`,
          { code: "SHAPE_MISMATCH", expected: describeType(childDef), actual: undefined },
        );
        ok = false;
        continue;
      }
      ok = this.checkValue(rowIndex, childDef, obj[key], [...path, key]) && ok;
    }
    if (this.unknownKeys === "error") {
      for (const key of Object.keys(obj)) {
        if (!(key in shape)) {
          this.addError(rowIndex, [...path, key], `スキーマに無いキー "${key}" があります`, {
            code: "UNKNOWN_KEY",
            key,
          });
          ok = false;
        }
      }
    }
    return ok;
  }

  private mismatch(
    rowIndex: number,
    def: ColumnDef,
    value: unknown,
    path: readonly (string | number)[],
  ): void {
    this.addError(
      rowIndex,
      path,
      `型が一致しません（期待: ${describeType(def)}、実際: ${show(value)}）`,
      { code: "SHAPE_MISMATCH", expected: describeType(def), actual: value },
    );
  }
}

/**
 * スキーマの全制約でデータを検証する。fail-fast せず全エラーを収集して返す。
 * shape が壊れた行は関係検証（FK / mustMatch など）をスキップしてノイズを減らす。
 */
export function validate<S extends SchemaTables>(
  schema: Schema<S>,
  data: TablesData<S>,
  options: ValidateOptions = {},
): ValidationResult {
  const unknownKeys = options.unknownKeys ?? "error";
  const errors: ValidationError[] = [];
  const dataRecord = data as Readonly<Record<string, readonly unknown[]>>;

  for (const [tableKey] of schema._.tables) {
    if (!Array.isArray(dataRecord[tableKey])) {
      throw new JsonRdbError(
        `テーブル "${tableKey}" のデータが配列ではありません（データのキー: ${Object.keys(dataRecord).join(", ")}）`,
      );
    }
  }

  for (const [tableKey, table] of schema._.tables) {
    const constraints = schema._.constraints.get(tableKey);
    const validator = new TableValidator(
      tableKey,
      table,
      dataRecord[tableKey] as readonly unknown[],
      constraints?.pk ?? null,
      unknownKeys,
      errors,
    );
    validator.validateShape();
  }

  return { ok: errors.length === 0, errors };
}
