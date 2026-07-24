import type { ColMeta } from "./column.js";
import { JsonRdbError, formatErrors } from "./errors.js";
import { type OrderSpec, compareBySpec } from "./expr.js";
import { type Schema, type SchemaTables, type TablesData, constraintsOf } from "./schema.js";
import { type Projection, type QuerySources, SelectEntry } from "./select.js";
import { type AnyTable, ColumnRef, type InferRow, type PkValue } from "./table.js";
import { type ValidateOptions, validate } from "./validate.js";

type Row = Record<string, unknown>;

/** Returns a new array sorted by the OrderSpec columns (the input is left alone). */
export function sortRows<T>(
  rows: readonly T[],
  specs: readonly OrderSpec[],
  table: AnyTable,
): readonly T[] {
  const columns = specs.map((spec) => {
    const expr = spec.expr;
    if (!(expr instanceof ColumnRef) || expr.table !== table) {
      throw new JsonRdbError(
        `defaultOrder only accepts column references of "${table._.name}" itself`,
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
 * An in-memory database. The data is held as-is: neither validated nor copied,
 * on the assumption that CI has already validated it (during development, use
 * createValidatedDb). PK / unique Map indexes are built lazily on first access.
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
          `data for table "${tableKey}" is not an array (data keys: ${Object.keys(dataRecord).join(", ")})`,
        );
      }
      this.rowsByTable.set(table, rows as readonly Row[]);
    }
  }

  private tableKeyOf(table: AnyTable): string {
    const tableKey = this.schema._.keyByTable.get(table);
    if (tableKey === undefined) {
      throw new JsonRdbError(`table "${table._.name}" is not part of this database's schema`);
    }
    return tableKey;
  }

  /** The raw rows of a table, in insertion order. */
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
      throw new JsonRdbError(`table "${table._.name}" has no primaryKey (get is unavailable)`);
    }
    return pk;
  }

  /** O(1) lookup by primary key. */
  get<T extends AnyTable>(table: T, pk: PkValue<T>): InferRow<T> | undefined {
    return this.uniqueIndexOf(table, this.pkColumnOf(table)).get(pk) as InferRow<T> | undefined;
  }

  getOrThrow<T extends AnyTable>(table: T, pk: PkValue<T>): InferRow<T> {
    const row = this.get(table, pk);
    if (row === undefined) {
      throw new JsonRdbError(
        `no row with ${this.pkColumnOf(table)}=${JSON.stringify(pk)} in ${table._.name}`,
      );
    }
    return row;
  }

  /** O(1) lookup by a unique column. Non-unique columns are rejected at compile time and at runtime. */
  getBy<M extends ColMeta & { unique: true }, TRow>(
    column: ColumnRef<M, TRow>,
    value: NonNullable<M["data"]>,
  ): TRow | undefined {
    const table = column.table;
    const constraints = constraintsOf(this.schema, this.tableKeyOf(table));
    if (!constraints.uniques.includes(column.key)) {
      throw new JsonRdbError(`getBy: ${table._.name}.${column.key} is not unique`);
    }
    return this.uniqueIndexOf(table, column.key).get(value) as TRow | undefined;
  }

  /** Every row. Applies defaultOrder when there is one (the result is cached). */
  all<T extends AnyTable>(table: T): readonly InferRow<T>[] {
    const cached = this.sortedCache.get(table);
    if (cached !== undefined) return cached as readonly InferRow<T>[];
    const rows = this.rowsByTable.get(table);
    if (rows === undefined) this.tableKeyOf(table); // delegate the throw for an unregistered table
    const specs = table._.config.defaultOrder;
    const result =
      specs !== undefined && specs.length > 0 ? sortRows(rows ?? [], specs, table) : (rows ?? []);
    this.sortedCache.set(table, result);
    return result as readonly InferRow<T>[];
  }

  count(table: AnyTable): number {
    return this.rowsOf(table).length;
  }

  /** The typed query builder, in its two forms: with and without a projection. */
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
 * A development and testing helper that validates before building the database.
 * Throws with the output of formatErrors when there are validation errors.
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
