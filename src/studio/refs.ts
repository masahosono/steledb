/**
 * The data-dependent half of the reference graph. meta.ts says *which* columns
 * point where; this resolves actual rows: the row a foreign key lands on, and
 * the rows pointing back at a given row. Indexes are built lazily per
 * (table, column) pair and thrown away whenever the data changes.
 */
import { formatErrorPath } from "../errors.js";
import { hitsAtPath, isPlainObject } from "../paths.js";
import type { AnySchema } from "../schema.js";
import type { StudioMeta, StudioTableMeta } from "./meta.js";

export type TableData = Readonly<Record<string, readonly unknown[]>>;

/** A pointer to one row, carrying enough context for the UI to render a link. */
export interface RowRef {
  /** Schema key of the table the row lives in */
  readonly table: string;
  readonly rowIndex: number;
  readonly rowLabel: string;
  /** Primary key value, when the table has one and the row carries it */
  readonly pkValue: string | number | null;
  /** Where inside the row the reference sits (e.g. "tracks[2].songId"). Empty for a plain row pointer */
  readonly pathString: string;
}

/**
 * A human readable label for a row. displayAs wins when the table declares one;
 * otherwise the first label column with a usable value, falling back to the
 * primary key and finally the row index.
 */
export function rowLabelOf(
  schema: AnySchema,
  table: StudioTableMeta,
  row: unknown,
  rowIndex: number,
): string {
  const displayAs = schema._.tables.get(table.key)?._.config.displayAs;
  if (displayAs !== undefined) {
    try {
      const label = displayAs(row);
      if (typeof label === "string" && label !== "") return label;
    } catch {
      // displayAs can throw on a row with a broken shape, so fall through
    }
  }
  if (isPlainObject(row)) {
    for (const key of table.labelColumns) {
      const value = row[key];
      if (typeof value === "string" && value !== "") return value;
    }
    if (table.pk !== null) {
      const pk = row[table.pk];
      if (typeof pk === "string" || typeof pk === "number") return String(pk);
    }
  }
  return `row ${rowIndex}`;
}

export function pkValueOf(table: StudioTableMeta, row: unknown): string | number | null {
  if (table.pk === null || !isPlainObject(row)) return null;
  const value = row[table.pk];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export class ReferenceIndex {
  private readonly schema: AnySchema;
  private readonly meta: StudioMeta;
  private readonly data: TableData;
  private readonly tablesByKey = new Map<string, StudioTableMeta>();
  /** "<table>.<column>" to value-to-rowIndex, for resolving a foreign key */
  private readonly forward = new Map<string, ReadonlyMap<unknown, number>>();
  /** "<table>.<column>" to value-to-referring-rows */
  private readonly backward = new Map<string, ReadonlyMap<unknown, readonly RowRef[]>>();

  constructor(schema: AnySchema, meta: StudioMeta, data: TableData) {
    this.schema = schema;
    this.meta = meta;
    this.data = data;
    for (const table of meta.tables) {
      this.tablesByKey.set(table.key, table);
    }
  }

  private rowsOf(tableKey: string): readonly unknown[] {
    return this.data[tableKey] ?? [];
  }

  labelOf(tableKey: string, rowIndex: number): string {
    const table = this.tablesByKey.get(tableKey);
    if (table === undefined) return `row ${rowIndex}`;
    return rowLabelOf(this.schema, table, this.rowsOf(tableKey)[rowIndex], rowIndex);
  }

  /** Resolves a foreign key value to the row index it points at, or undefined when dangling. */
  resolve(tableKey: string, columnKey: string, value: unknown): number | undefined {
    const cacheKey = `${tableKey}.${columnKey}`;
    let index = this.forward.get(cacheKey);
    if (index === undefined) {
      const built = new Map<unknown, number>();
      this.rowsOf(tableKey).forEach((row, rowIndex) => {
        if (!isPlainObject(row)) return;
        const candidate = row[columnKey];
        if (candidate === null || candidate === undefined) return;
        if (!built.has(candidate)) built.set(candidate, rowIndex);
      });
      index = built;
      this.forward.set(cacheKey, index);
    }
    return index.get(value);
  }

  /** Resolves a foreign key to a full RowRef, for rendering a link target. */
  resolveRef(tableKey: string, columnKey: string, value: unknown): RowRef | undefined {
    const rowIndex = this.resolve(tableKey, columnKey, value);
    if (rowIndex === undefined) return undefined;
    const table = this.tablesByKey.get(tableKey);
    if (table === undefined) return undefined;
    const row = this.rowsOf(tableKey)[rowIndex];
    return {
      table: tableKey,
      rowIndex,
      rowLabel: rowLabelOf(this.schema, table, row, rowIndex),
      pkValue: pkValueOf(table, row),
      pathString: "",
    };
  }

  /**
   * Every row pointing at `value` in `tableKey.columnKey`. The index is built
   * across all incoming references at once, since a single scan of the
   * referring tables covers every value.
   */
  backlinksOf(tableKey: string, columnKey: string, value: unknown): readonly RowRef[] {
    const cacheKey = `${tableKey}.${columnKey}`;
    let index = this.backward.get(cacheKey);
    if (index === undefined) {
      index = this.buildBacklinks(tableKey, columnKey);
      this.backward.set(cacheKey, index);
    }
    return index.get(value) ?? [];
  }

  private buildBacklinks(
    tableKey: string,
    columnKey: string,
  ): ReadonlyMap<unknown, readonly RowRef[]> {
    const target = this.tablesByKey.get(tableKey);
    const built = new Map<unknown, RowRef[]>();
    if (target === undefined) return built;

    for (const incoming of target.referencedBy) {
      if (incoming.column !== columnKey) continue;
      const fromTable = this.tablesByKey.get(incoming.fromTable);
      if (fromTable === undefined) continue;

      this.rowsOf(incoming.fromTable).forEach((row, rowIndex) => {
        for (const hit of hitsAtPath(row, incoming.path)) {
          if (hit.value === null || hit.value === undefined) continue;
          const list = built.get(hit.value);
          const ref: RowRef = {
            table: incoming.fromTable,
            rowIndex,
            rowLabel: rowLabelOf(this.schema, fromTable, row, rowIndex),
            pkValue: pkValueOf(fromTable, row),
            pathString: formatErrorPath(hit.path),
          };
          if (list === undefined) {
            built.set(hit.value, [ref]);
          } else {
            list.push(ref);
          }
        }
      });
    }
    return built;
  }

  /** Total number of rows pointing at a row, across every incoming reference. */
  backlinkCountOf(tableKey: string, row: unknown): number {
    const table = this.tablesByKey.get(tableKey);
    if (table === undefined || !isPlainObject(row)) return 0;
    const columns = new Set(table.referencedBy.map((r) => r.column));
    let total = 0;
    for (const column of columns) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      total += this.backlinksOf(tableKey, column, value).length;
    }
    return total;
  }

  get metaTables(): readonly StudioTableMeta[] {
    return this.meta.tables;
  }
}
