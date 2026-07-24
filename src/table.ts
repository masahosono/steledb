import type { ColMeta, ColumnDef, InferShape, Shape } from "./column.js";
import { JsonRdbError } from "./errors.js";
import { EXPR, type Expr, type ExprNode, type OrderSpec } from "./expr.js";

/**
 * テーブルに束縛されたカラム参照。クエリ式（where / orderBy / 射影）に
 * そのまま渡せる Expr でもある。`~row` は所属テーブルの行型を運ぶ phantom。
 */
export class ColumnRef<M extends ColMeta = ColMeta, TRow = unknown> implements Expr<M["data"]> {
  declare readonly _: M;
  declare readonly "~data"?: M["data"];
  declare readonly "~row"?: TRow;
  readonly [EXPR]: ExprNode;
  readonly table: AnyTable;
  readonly key: string;
  readonly def: ColumnDef;

  constructor(table: AnyTable, key: string, def: ColumnDef) {
    this.table = table;
    this.key = key;
    this.def = def;
    this[EXPR] = { kind: "column", table, key, def };
  }
}

export type AnyColumnRef = ColumnRef<any, any>;

/** テーブル単位のカスタム検証。エラーメッセージを返すと違反、null/undefined で合格。 */
export type TableCheck<Row> = (row: Row) => string | null | undefined;

export interface TableConfig<Row> {
  /** db.all() や射影なし select のデフォルト並び順 */
  readonly defaultOrder?: readonly OrderSpec[];
  /** 検証エラーで行を人間が特定するための表示（例: `"Deep Blue" (id=...)`） */
  readonly displayAs?: (row: Row) => string;
  /** スキーマ DSL で表現できない任意検証の逃げ道 */
  readonly checks?: readonly TableCheck<Row>[];
}

export interface TableMeta {
  readonly name: string;
  readonly shape: Readonly<Record<string, ColumnDef>>;
  readonly columns: Readonly<Record<string, AnyColumnRef>>;
  readonly config: TableConfig<any>;
}

/**
 * table() の戻り値。束縛済みカラム参照へ `songs.id` のように直接アクセスできる。
 * `_` はメタデータ用に予約（カラム名に使えない）。`~row` / `~name` / `~pk` は
 * 型推論用の phantom プロパティで実行時には存在しない。
 */
export type Table<TName extends string, S extends Shape> = {
  readonly [K in keyof S]: ColumnRef<S[K]["_"], InferShape<S>>;
} & TableBrand<TName, InferShape<S>, PkDataOf<S>>;

export interface TableBrand<TName extends string = string, TRow = unknown, TPk = unknown> {
  readonly _: TableMeta;
  readonly "~name"?: TName;
  readonly "~row"?: TRow;
  readonly "~pk"?: TPk;
}

export type AnyTable = TableBrand;

export type InferRow<T extends AnyTable> = NonNullable<T["~row"]>;

/** 値がテーブル実体かどうか（射影エントリの判別に使う） */
export function isTable(value: unknown): value is AnyTable {
  if (typeof value !== "object" || value === null) return false;
  const meta = (value as { _?: { name?: unknown; columns?: unknown } })._;
  return meta !== undefined && typeof meta.name === "string" && typeof meta.columns === "object";
}
export type TableName<T extends AnyTable> = NonNullable<T["~name"]>;
/** PK カラムの値型。PK 未宣言テーブルでは never（= db.get() が型レベルで呼べない） */
export type PkValue<T extends AnyTable> = NonNullable<T["~pk"]>;

type PkDataOf<S extends Shape> = {
  [K in keyof S]: S[K]["_"]["primaryKey"] extends true ? NonNullable<S[K]["_"]["data"]> : never;
}[keyof S];

/**
 * テーブル定義。shape のカラムビルダーを ColumnRef に束縛し、`songs.id` の形で
 * 参照できるオブジェクトを返す。第 3 引数で defaultOrder / displayAs / checks を
 * 束縛済みカラム参照を使って指定できる。
 */
export function table<TName extends string, S extends Shape>(
  name: TName,
  shape: S,
  config?: (self: Table<TName, S>) => TableConfig<InferShape<S>>,
): Table<TName, S> {
  const columns: Record<string, AnyColumnRef> = {};
  const shapeDefs: Record<string, ColumnDef> = {};
  const meta = { name, shape: shapeDefs, columns, config: {} as TableConfig<any> };
  const tbl = {} as Record<string, unknown>;
  Object.defineProperty(tbl, "_", { value: meta, enumerable: false });

  for (const [key, column] of Object.entries(shape)) {
    if (key === "_" || key.startsWith("~") || key.startsWith("$")) {
      throw new JsonRdbError(
        `テーブル "${name}": カラム名 "${key}" は使用できません（"_" と "~", "$" 始まりは予約されています）`,
      );
    }
    const ref = new ColumnRef(tbl as unknown as AnyTable, key, column.def);
    shapeDefs[key] = column.def;
    columns[key] = ref;
    tbl[key] = ref;
  }

  const result = tbl as unknown as Table<TName, S>;
  if (config) {
    (meta as { config: TableConfig<any> }).config = config(result);
  }
  return result;
}
