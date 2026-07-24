import type { ColumnDef } from "./column.js";
import {
  JsonRdbError,
  type ValidationError,
  type ValidationErrorBase,
  formatErrorPath,
} from "./errors.js";
import {
  type Path,
  type ResolvedColumn,
  type Schema,
  type SchemaTables,
  type TableConstraints,
  type TablesData,
  formatPath,
} from "./schema.js";
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

interface PathHit {
  readonly value: unknown;
  /** 配列インデックスを埋めた具体的なパス */
  readonly path: readonly (string | number)[];
}

/**
 * スキーマパス（"[]" マーカー入り）を具体的な行データ上で走査し、該当する
 * 値と具体パスを全件収集する。存在しないキー（optional の欠落）や構造の
 * 崩れは黙ってスキップする（shape 検証済みの行に対して使う前提）。
 */
function collectAtPath(
  value: unknown,
  segments: Path,
  concrete: readonly (string | number)[],
  out: PathHit[],
): void {
  if (segments.length === 0) {
    out.push({ value, path: concrete });
    return;
  }
  const head = segments[0] as string;
  const rest = segments.slice(1);
  if (head === "[]") {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => {
      collectAtPath(item, rest, [...concrete, index], out);
    });
    return;
  }
  if (!isPlainObject(value) || !(head in value)) return;
  collectAtPath(value[head], rest, [...concrete, head], out);
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
        const matches =
          (def.kind === "string" && typeof value === "string") ||
          (def.kind === "number" && typeof value === "number") ||
          (def.kind === "boolean" && typeof value === "boolean");
        if (matches) return true;
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

  /** unique / primaryKey カラムの重複検出。null は複数あってよい */
  validateUniques(uniques: readonly string[]): void {
    for (const column of uniques) {
      const seen = new Map<unknown, number>();
      this.rows.forEach((row, rowIndex) => {
        if (!isPlainObject(row)) return;
        const value = row[column];
        if (typeof value !== "string" && typeof value !== "number") return;
        const other = seen.get(value);
        if (other === undefined) {
          seen.set(value, rowIndex);
          return;
        }
        this.addError(
          rowIndex,
          [column],
          `${column} ${show(value)} が重複しています（行 ${other} と同じ値）`,
          { code: "DUPLICATE_KEY", column, value, otherRowIndex: other },
        );
      });
    }
  }

  /** FK の存在検証。null / 欠落はスキップ（nullable / optional FK） */
  validateReferences(
    references: TableConstraints["references"],
    shapeOk: readonly boolean[],
    valueSetOf: (target: ResolvedColumn) => ReadonlySet<unknown>,
  ): void {
    for (const ref of references) {
      const known = valueSetOf(ref.target);
      this.rows.forEach((row, rowIndex) => {
        if (!shapeOk[rowIndex]) return;
        const hits: PathHit[] = [];
        collectAtPath(row, ref.path, [], hits);
        for (const hit of hits) {
          if (hit.value === null || hit.value === undefined) continue;
          if (known.has(hit.value)) continue;
          this.addError(
            rowIndex,
            hit.path,
            `${show(hit.value)} が ${ref.target.tableKey}.${ref.target.columnKey} に存在しません`,
            {
              code: "FK_VIOLATION",
              value: hit.value,
              refTable: ref.target.tableKey,
              refColumn: ref.target.columnKey,
            },
          );
        }
      });
    }
  }

  /** 非正規化フィールドの一致検証（厳密 / alias 許容） */
  validateMustMatches(
    mustMatches: TableConstraints["mustMatches"],
    shapeOk: readonly boolean[],
    masterIndexOf: (target: ResolvedColumn) => ReadonlyMap<unknown, Record<string, unknown>>,
  ): void {
    for (const mm of mustMatches) {
      const parentPath = mm.path.slice(0, -1);
      const field = mm.path[mm.path.length - 1] as string;
      const masters = masterIndexOf(mm.viaTarget);
      this.rows.forEach((row, rowIndex) => {
        if (!shapeOk[rowIndex]) return;
        const parents: PathHit[] = [];
        collectAtPath(row, parentPath, [], parents);
        for (const parent of parents) {
          if (!isPlainObject(parent.value)) continue;
          const actual = parent.value[field];
          const viaValue = parent.value[mm.via];
          // 値か FK が null / 欠落なら検証対象外。FK 切れは FK_VIOLATION 側で報告済み
          if (actual === null || actual === undefined) continue;
          if (viaValue === null || viaValue === undefined) continue;
          const master = masters.get(viaValue);
          if (master === undefined) continue;
          const expected = master[mm.target.columnKey];
          if (actual === expected) continue;
          let aliases: readonly unknown[] | undefined;
          if (mm.orIn) {
            const orInValue = master[mm.orIn.columnKey];
            aliases = Array.isArray(orInValue) ? orInValue : [];
            if (aliases.includes(actual)) continue;
          }
          const refKeyPath = `${mm.target.tableKey}[${String(viaValue)}].${mm.target.columnKey}`;
          const message = mm.orIn
            ? `${show(actual)} が ${refKeyPath} ${show(expected)} と一致せず ${mm.orIn.columnKey} にも含まれません`
            : `${show(actual)} が ${refKeyPath} ${show(expected)} と一致しません`;
          this.addError(rowIndex, [...parent.path, field], message, {
            code: "DENORMALIZED_MISMATCH",
            actual,
            expected,
            ...(aliases === undefined ? {} : { allowedAliases: aliases }),
            refTable: mm.target.tableKey,
            refKeyPath,
          });
        }
      });
    }
  }

  /** 親レコード内スコープの複合 unique（uniqueBy）検証 */
  validateUniqueBys(uniqueBys: TableConstraints["uniqueBys"], shapeOk: readonly boolean[]): void {
    for (const ub of uniqueBys) {
      const extractKey = ub.key as (element: unknown) => unknown;
      this.rows.forEach((row, rowIndex) => {
        if (!shapeOk[rowIndex]) return;
        const hits: PathHit[] = [];
        collectAtPath(row, ub.path, [], hits);
        for (const hit of hits) {
          if (!Array.isArray(hit.value)) continue;
          const seen = new Map<string, number>();
          hit.value.forEach((element, index) => {
            const key = extractKey(element);
            const keyArray = Array.isArray(key) ? key : [key];
            const serialized = JSON.stringify(keyArray);
            const other = seen.get(serialized);
            if (other === undefined) {
              seen.set(serialized, index);
              return;
            }
            this.addError(
              rowIndex,
              [...hit.path, index],
              `${formatPath(ub.path)} 内でキー ${serialized} が重複しています（要素 ${other} と ${index}）`,
              { code: "SCOPED_DUPLICATE", scopePath: formatPath(ub.path), key: keyArray },
            );
          });
        }
      });
    }
  }

  /** テーブル定義のカスタム checks を実行する */
  validateChecks(shapeOk: readonly boolean[]): void {
    const checks = this.table._.config.checks;
    if (checks === undefined || checks.length === 0) return;
    this.rows.forEach((row, rowIndex) => {
      if (!shapeOk[rowIndex]) return;
      for (const check of checks) {
        let detail: string | null | undefined;
        try {
          detail = check(row);
        } catch (cause) {
          detail = `check が例外を投げました: ${String(cause)}`;
        }
        if (typeof detail === "string") {
          this.addError(rowIndex, [], detail, { code: "CHECK_FAILED", detail });
        }
      }
    });
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

  // 1) shape 検証（行ごとの合否を保持し、壊れた行は関係検証から除外する）
  const validators = new Map<string, TableValidator>();
  const shapeOkByTable = new Map<string, boolean[]>();
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
    validators.set(tableKey, validator);
    shapeOkByTable.set(tableKey, validator.validateShape());
  }

  // 2) 参照先カラムの値インデックス（必要になったターゲットだけ遅延構築）
  const valueSets = new Map<string, ReadonlySet<unknown>>();
  const masterIndexes = new Map<string, ReadonlyMap<unknown, Record<string, unknown>>>();
  const cacheKeyOf = (target: ResolvedColumn): string => `${target.tableKey}.${target.columnKey}`;

  const valueSetOf = (target: ResolvedColumn): ReadonlySet<unknown> => {
    const cacheKey = cacheKeyOf(target);
    const cached = valueSets.get(cacheKey);
    if (cached !== undefined) return cached;
    const values = new Set<unknown>();
    for (const row of dataRecord[target.tableKey] ?? []) {
      if (!isPlainObject(row)) continue;
      const value = row[target.columnKey];
      if (typeof value === "string" || typeof value === "number") values.add(value);
    }
    valueSets.set(cacheKey, values);
    return values;
  };

  const masterIndexOf = (target: ResolvedColumn): ReadonlyMap<unknown, Record<string, unknown>> => {
    const cacheKey = cacheKeyOf(target);
    const cached = masterIndexes.get(cacheKey);
    if (cached !== undefined) return cached;
    const index = new Map<unknown, Record<string, unknown>>();
    for (const row of dataRecord[target.tableKey] ?? []) {
      if (!isPlainObject(row)) continue;
      const value = row[target.columnKey];
      if ((typeof value === "string" || typeof value === "number") && !index.has(value)) {
        index.set(value, row);
      }
    }
    masterIndexes.set(cacheKey, index);
    return index;
  };

  // 3) 制約検証
  for (const [tableKey] of schema._.tables) {
    const constraints = schema._.constraints.get(tableKey);
    const validator = validators.get(tableKey);
    const shapeOk = shapeOkByTable.get(tableKey);
    if (constraints === undefined || validator === undefined || shapeOk === undefined) continue;
    validator.validateUniques(constraints.uniques);
    validator.validateReferences(constraints.references, shapeOk, valueSetOf);
    validator.validateMustMatches(constraints.mustMatches, shapeOk, masterIndexOf);
    validator.validateUniqueBys(constraints.uniqueBys, shapeOk);
    validator.validateChecks(shapeOk);
  }

  return { ok: errors.length === 0, errors };
}
