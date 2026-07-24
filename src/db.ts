import type { ColMeta } from "./column.js";
import { JsonRdbError, formatErrors } from "./errors.js";
import { type OrderSpec, compareBySpec } from "./expr.js";
import { type Schema, type SchemaTables, type TablesData, constraintsOf } from "./schema.js";
import { type Projection, type QuerySources, SelectEntry } from "./select.js";
import { type AnyTable, ColumnRef, type InferRow, type PkValue } from "./table.js";
import { type ValidateOptions, validate } from "./validate.js";

type Row = Record<string, unknown>;

/** OrderSpec の列でソートした新しい配列を返す（元配列は変更しない） */
export function sortRows<T>(
  rows: readonly T[],
  specs: readonly OrderSpec[],
  table: AnyTable,
): readonly T[] {
  const columns = specs.map((spec) => {
    const expr = spec.expr;
    if (!(expr instanceof ColumnRef) || expr.table !== table) {
      throw new JsonRdbError(
        `defaultOrder には "${table._.name}" 自身のカラム参照のみ指定できます`,
      );
    }
    return { key: expr.key, spec };
  });
  return [...rows].sort((a, b) => {
    for (const { key, spec } of columns) {
      const result = compareBySpec((a as Row)[key], (b as Row)[key], spec);
      if (result !== 0) return result;
    }
    return 0;
  });
}

/**
 * インメモリ DB。データは検証もコピーもせず信頼して保持する（本番は CI で
 * validate 済みの前提。開発時は createValidatedDb を使う）。PK / unique の
 * Map インデックスは初回アクセス時に遅延構築する。
 */
export class Db<S extends SchemaTables> {
  readonly schema: Schema<S>;
  private readonly rowsByTable = new Map<AnyTable, readonly Row[]>();
  private readonly uniqueIndexes = new Map<AnyTable, Map<string, ReadonlyMap<unknown, Row>>>();
  private readonly sortedCache = new Map<AnyTable, readonly Row[]>();

  constructor(schema: Schema<S>, data: TablesData<S>) {
    this.schema = schema;
    const dataRecord = data as Readonly<Record<string, readonly unknown[]>>;
    for (const [tableKey, table] of schema._.tables) {
      const rows = dataRecord[tableKey];
      if (!Array.isArray(rows)) {
        throw new JsonRdbError(
          `テーブル "${tableKey}" のデータが配列ではありません（データのキー: ${Object.keys(dataRecord).join(", ")}）`,
        );
      }
      this.rowsByTable.set(table, rows as readonly Row[]);
    }
  }

  private tableKeyOf(table: AnyTable): string {
    const tableKey = this.schema._.keyByTable.get(table);
    if (tableKey === undefined) {
      throw new JsonRdbError(`テーブル "${table._.name}" はこの DB のスキーマに含まれていません`);
    }
    return tableKey;
  }

  /** テーブルの生データ（注入順のまま） */
  rowsOf<T extends AnyTable>(table: T): readonly InferRow<T>[] {
    this.tableKeyOf(table);
    return (this.rowsByTable.get(table) ?? []) as readonly InferRow<T>[];
  }

  private uniqueIndexOf(table: AnyTable, columnKey: string): ReadonlyMap<unknown, Row> {
    let byColumn = this.uniqueIndexes.get(table);
    if (byColumn === undefined) {
      byColumn = new Map();
      this.uniqueIndexes.set(table, byColumn);
    }
    const cached = byColumn.get(columnKey);
    if (cached !== undefined) return cached;
    const index = new Map<unknown, Row>();
    for (const row of this.rowsByTable.get(table) ?? []) {
      const value = row[columnKey];
      if (value !== null && value !== undefined && !index.has(value)) {
        index.set(value, row);
      }
    }
    byColumn.set(columnKey, index);
    return index;
  }

  private pkColumnOf(table: AnyTable): string {
    const pk = constraintsOf(this.schema, this.tableKeyOf(table)).pk;
    if (pk === null) {
      throw new JsonRdbError(
        `テーブル "${table._.name}" に primaryKey がありません（get は使えません）`,
      );
    }
    return pk;
  }

  /** PK による O(1) lookup */
  get<T extends AnyTable>(table: T, pk: PkValue<T>): InferRow<T> | undefined {
    return this.uniqueIndexOf(table, this.pkColumnOf(table)).get(pk) as InferRow<T> | undefined;
  }

  getOrThrow<T extends AnyTable>(table: T, pk: PkValue<T>): InferRow<T> {
    const row = this.get(table, pk);
    if (row === undefined) {
      throw new JsonRdbError(
        `${table._.name} に ${this.pkColumnOf(table)}=${JSON.stringify(pk)} の行が見つかりません`,
      );
    }
    return row;
  }

  /** unique カラムによる O(1) lookup。unique 宣言の無いカラムはコンパイル・実行時とも拒否 */
  getBy<M extends ColMeta & { unique: true }, TRow>(
    column: ColumnRef<M, TRow>,
    value: NonNullable<M["data"]>,
  ): TRow | undefined {
    const table = column.table;
    const constraints = constraintsOf(this.schema, this.tableKeyOf(table));
    if (!constraints.uniques.includes(column.key)) {
      throw new JsonRdbError(`getBy: ${table._.name}.${column.key} は unique ではありません`);
    }
    return this.uniqueIndexOf(table, column.key).get(value) as TRow | undefined;
  }

  /** 全件。defaultOrder があれば適用した配列を返す（結果はキャッシュされる） */
  all<T extends AnyTable>(table: T): readonly InferRow<T>[] {
    const cached = this.sortedCache.get(table);
    if (cached !== undefined) return cached as readonly InferRow<T>[];
    const rows = this.rowsByTable.get(table);
    if (rows === undefined) this.tableKeyOf(table); // 未登録テーブルの throw を委譲
    const specs = table._.config.defaultOrder;
    const result =
      specs !== undefined && specs.length > 0 ? sortRows(rows ?? [], specs, table) : (rows ?? []);
    this.sortedCache.set(table, result);
    return result as readonly InferRow<T>[];
  }

  count(table: AnyTable): number {
    return this.rowsOf(table).length;
  }

  /** 型付きクエリビルダー。射影あり/なしの 2 形態 */
  select(): SelectEntry<undefined>;
  select<P extends Projection>(projection: P): SelectEntry<P>;
  select(projection?: Projection): SelectEntry<Projection | undefined> {
    const sources: QuerySources = {
      rowsOf: (table) => {
        this.tableKeyOf(table);
        return this.rowsByTable.get(table) ?? [];
      },
      defaultOrderOf: (table) => table._.config.defaultOrder,
    };
    return new SelectEntry(sources, projection);
  }
}

export function createDb<S extends SchemaTables>(schema: Schema<S>, data: TablesData<S>): Db<S> {
  return new Db(schema, data);
}

/**
 * validate してから DB を構築する開発・テスト用ヘルパー。
 * 検証エラーがあれば formatErrors の内容で throw する。
 */
export function createValidatedDb<S extends SchemaTables>(
  schema: Schema<S>,
  data: TablesData<S>,
  options?: ValidateOptions,
): Db<S> {
  const result = validate(schema, data, options);
  if (!result.ok) {
    throw new JsonRdbError(formatErrors(result.errors));
  }
  return new Db(schema, data);
}
