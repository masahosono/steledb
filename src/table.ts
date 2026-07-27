import type { ColMeta, ColumnDef, InferShape, Shape } from "./column.js";
import { SteleDbError } from "./errors.js";
import { EXPR, type Expr, type ExprNode, type OrderSpec } from "./expr.js";

/**
 * A column reference bound to a table. It is also an Expr, so it can be passed
 * directly to a query expression (where / orderBy / projection). `~row` is a
 * phantom property carrying the row type of the owning table.
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

/** A custom per-table check. Return a message to report a violation, null/undefined to pass. */
export type TableCheck<Row> = (row: Row) => string | null | undefined;

/**
 * A column reference usable in a table-level constraint. The row type ties it to
 * the table being defined, so a column borrowed from another table is a compile
 * error (defineSchema checks the same thing at runtime).
 */
export type SelfColumnRef<Row> = ColumnRef<ColMeta, Row>;

export interface TableConfig<Row> {
  /** Default ordering for db.all() and for a select without a projection */
  readonly defaultOrder?: readonly OrderSpec[];
  /** How to identify a row in validation errors (e.g. `"Deep Blue" (s1)`) */
  readonly displayAs?: (row: Row) => string;
  /** Escape hatch for checks the schema DSL cannot express */
  readonly checks?: readonly TableCheck<Row>[];
  /**
   * A composite primary key: two or more of this table's own columns, in the
   * order db.get() takes them (for a single column use `.primaryKey()` on the
   * column itself).
   */
  readonly primaryKey?: readonly SelfColumnRef<Row>[];
  /**
   * Composite unique constraints, each one a list of two or more of this table's
   * own columns (for a single column use `.unique()` on the column itself).
   */
  readonly unique?: readonly (readonly SelfColumnRef<Row>[])[];
}

export interface TableMeta {
  readonly name: string;
  readonly shape: Readonly<Record<string, ColumnDef>>;
  readonly columns: Readonly<Record<string, AnyColumnRef>>;
  readonly config: TableConfig<any>;
}

/**
 * The return value of table(). Bound column references are reachable directly,
 * as in `songs.id`. `_` is reserved for metadata (so it cannot be a column name).
 * `~row` / `~name` / `~pk` are phantom properties for type inference and do not
 * exist at runtime.
 */
export type Table<TName extends string, S extends Shape, TPk = PkDataOf<S>> = {
  readonly [K in keyof S]: ColumnRef<S[K]["_"], InferShape<S>>;
} & TableBrand<TName, InferShape<S>, TPk>;

export interface TableBrand<TName extends string = string, TRow = unknown, TPk = unknown> {
  readonly _: TableMeta;
  readonly "~name"?: TName;
  readonly "~row"?: TRow;
  readonly "~pk"?: TPk;
}

export type AnyTable = TableBrand;

export type InferRow<T extends AnyTable> = NonNullable<T["~row"]>;

/** Whether a value is a table itself (used to discriminate projection entries). */
export function isTable(value: unknown): value is AnyTable {
  if (typeof value !== "object" || value === null) return false;
  const meta = (value as { _?: { name?: unknown; columns?: unknown } })._;
  return meta !== undefined && typeof meta.name === "string" && typeof meta.columns === "object";
}
export type TableName<T extends AnyTable> = NonNullable<T["~name"]>;
/**
 * What db.get() takes: the value of the PK column, or a tuple in declaration
 * order for a composite key. never when no PK is declared, so db.get() cannot
 * be called at all.
 */
export type PkValue<T extends AnyTable> = NonNullable<T["~pk"]>;

type PkDataOf<S extends Shape> = {
  [K in keyof S]: S[K]["_"]["primaryKey"] extends true ? NonNullable<S[K]["_"]["data"]> : never;
}[keyof S];

/** The tuple of value types behind a composite primaryKey declared in the config. */
type CompositePkOf<C> = C extends { primaryKey: infer P extends readonly unknown[] }
  ? { [I in keyof P]: P[I] extends ColumnRef<infer M, any> ? NonNullable<M["data"]> : never }
  : never;

/** The composite key wins when the config declares one, otherwise the PK column's own type. */
type PkOf<S extends Shape, C> = [CompositePkOf<C>] extends [never] ? PkDataOf<S> : CompositePkOf<C>;

/**
 * Defines a table. Column builders in the shape are bound to ColumnRefs so they
 * can be reached as `songs.id`. The third argument configures defaultOrder /
 * displayAs / checks / composite keys in terms of those bound column references.
 * The config type parameter is `const` so that `primaryKey: [self.a, self.b]`
 * is captured as a tuple, which is what makes db.get() type-safe per position.
 */
export function table<
  TName extends string,
  S extends Shape,
  const C extends TableConfig<InferShape<S>>,
>(name: TName, shape: S, config?: (self: Table<TName, S>) => C): Table<TName, S, PkOf<S, C>> {
  const columns: Record<string, AnyColumnRef> = {};
  const shapeDefs: Record<string, ColumnDef> = {};
  const meta = { name, shape: shapeDefs, columns, config: {} as TableConfig<any> };
  const tbl = {} as Record<string, unknown>;
  Object.defineProperty(tbl, "_", { value: meta, enumerable: false });

  for (const [key, column] of Object.entries(shape)) {
    if (key === "_" || key.startsWith("~") || key.startsWith("$")) {
      throw new SteleDbError(
        `table "${name}": column name "${key}" is not allowed ("_" and names starting with "~" or "$" are reserved)`,
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
  return result as Table<TName, S, PkOf<S, C>>;
}
