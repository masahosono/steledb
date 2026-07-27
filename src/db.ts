import type { ColMeta } from "./column.js";
import { JsonRdbError, formatErrors } from "./errors.js";
import { type OrderSpec, compareBySpec } from "./expr.js";
import { type Schema, type SchemaTables, type TablesData, constraintsOf } from "./schema.js";
import { type Projection, type QuerySources, SelectEntry } from "./select.js";
import { type AnyTable, ColumnRef, type InferRow, type PkValue } from "./table.js";
import { type ValidateOptions, validate } from "./validate.js";

type Row = Record<string, unknown>;

/**
 * The key a row is indexed under: the raw value for a single column, the
 * serialized tuple for several. Undefined when a member is null or missing,
 * which keeps such a row out of the index entirely.
 */
function indexKeyOf(row: Row, columns: readonly string[]): unknown {
  const values: unknown[] = [];
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) return undefined;
    values.push(value);
  }
  return columns.length === 1 ? values[0] : JSON.stringify(values);
}

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

  /** A lazily built Map index over one or more columns (rows missing a member are left out). */
  private indexOf(table: AnyTable, columns: readonly string[]): ReadonlyMap<unknown, Row> {
    let byColumns = this.uniqueIndexes.get(table);
    if (byColumns === undefined) {
      byColumns = new Map();
      this.uniqueIndexes.set(table, byColumns);
    }
    const cacheKey = JSON.stringify(columns);
    const cached = byColumns.get(cacheKey);
    if (cached !== undefined) return cached;
    const index = new Map<unknown, Row>();
    for (const row of this.rowsByTable.get(table) ?? []) {
      const key = indexKeyOf(row, columns);
      if (key === undefined || index.has(key)) continue;
      index.set(key, row);
    }
    byColumns.set(cacheKey, index);
    return index;
  }

  private pkColumnsOf(table: AnyTable): readonly string[] {
    const pk = constraintsOf(this.schema, this.tableKeyOf(table)).pk;
    if (pk === null) {
      throw new JsonRdbError(`table "${table._.name}" has no primaryKey (get is unavailable)`);
    }
    return pk;
  }

  /**
   * The lookup key for a primary key value: the value itself for a simple key,
   * and the serialized tuple for a composite one (which is also how the index
   * stores it, since a Map cannot key on an array by value).
   */
  private lookupKeyOf(table: AnyTable, columns: readonly string[], pk: unknown): unknown {
    if (columns.length === 1) return pk;
    if (!Array.isArray(pk) || pk.length !== columns.length) {
      throw new JsonRdbError(
        `table "${table._.name}" has a composite primary key (${columns.join(", ")}), so get takes an array of ${columns.length} values in that order`,
      );
    }
    return JSON.stringify(pk);
  }

  /** O(1) lookup by primary key. A composite key is passed as an array, in declaration order. */
  get<T extends AnyTable>(table: T, pk: PkValue<T>): InferRow<T> | undefined {
    const columns = this.pkColumnsOf(table);
    const key = this.lookupKeyOf(table, columns, pk);
    return this.indexOf(table, columns).get(key) as InferRow<T> | undefined;
  }

  getOrThrow<T extends AnyTable>(table: T, pk: PkValue<T>): InferRow<T> {
    const row = this.get(table, pk);
    if (row === undefined) {
      throw new JsonRdbError(
        `no row with ${this.pkColumnsOf(table).join(", ")}=${JSON.stringify(pk)} in ${table._.name}`,
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
    return this.indexOf(table, [column.key]).get(value) as TRow | undefined;
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
