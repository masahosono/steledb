/**
 * Turns a schema into the JSON payload the studio front end runs on. Everything
 * the UI needs to render a table — column types, constraint badges, which cells
 * are foreign keys, and which other tables point back at this one — is derived
 * here from `schema._.constraints`, which defineSchema has already resolved.
 *
 * This module is pure and does not touch the filesystem.
 */
import type { ColumnDef } from "../column.js";
import type { AnySchema, Path } from "../schema.js";
import { constraintsOf, formatPath } from "../schema.js";

/** A foreign key declared somewhere inside a table, flattened to one entry per path. */
export interface StudioReference {
  /** Schema path, with "[]" markers (e.g. ["tracks", "[]", "songId"]) */
  readonly path: Path;
  /** Display form (e.g. "tracks[].songId") */
  readonly pathString: string;
  /** The top-level column the path starts at */
  readonly column: string;
  /** True when the FK is the top-level column itself, not something nested inside it */
  readonly topLevel: boolean;
  readonly targetTable: string;
  readonly targetColumn: string;
}

/** The mirror image of StudioReference: a foreign key pointing *at* this table. */
export interface StudioIncomingReference {
  /** Schema key of the table holding the foreign key */
  readonly fromTable: string;
  readonly path: Path;
  readonly pathString: string;
  /** The column of *this* table being pointed at */
  readonly column: string;
}

export interface StudioColumnMeta {
  readonly key: string;
  readonly kind: ColumnDef["kind"];
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  /** Present for kind === "enum" */
  readonly enumValues?: readonly string[];
  /** Rendered type, e.g. "string | null" or "object[]" */
  readonly typeLabel: string;
  /** Set when the column itself is a foreign key (so the grid can linkify the cell) */
  readonly reference?: { readonly table: string; readonly column: string };
  /** Foreign keys nested inside this column (arrays / objects), for the row detail view */
  readonly nestedReferences: readonly StudioReference[];
  /** True for array / object columns, which are edited as JSON rather than with a widget */
  readonly composite: boolean;
}

export interface StudioTableMeta {
  /** Schema key (also the route segment and the API path) */
  readonly key: string;
  /** table() name, which can differ from the schema key */
  readonly name: string;
  readonly file: string;
  readonly pk: string | null;
  readonly uniques: readonly string[];
  readonly columns: readonly StudioColumnMeta[];
  readonly references: readonly StudioReference[];
  readonly referencedBy: readonly StudioIncomingReference[];
  /** Column keys used to build a row label, mirroring displayAs when there is none */
  readonly labelColumns: readonly string[];
}

export interface StudioMeta {
  readonly tables: readonly StudioTableMeta[];
  readonly readOnly: boolean;
}

/** Renders a column's type for the header badge. */
export function typeLabelOf(def: ColumnDef): string {
  let base: string;
  switch (def.kind) {
    case "array":
      base = def.element === undefined ? "unknown[]" : `${typeLabelOf(def.element)}[]`;
      break;
    case "enum":
      base = "enum";
      break;
    default:
      base = def.kind;
  }
  return def.nullable ? `${base} | null` : base;
}

/**
 * Picks the columns a row label is built from when the table declares no
 * displayAs: the first string-ish column that is neither the PK nor a foreign
 * key, which in practice is the name / title of the record.
 */
function labelColumnsOf(
  shape: Readonly<Record<string, ColumnDef>>,
  pk: string | null,
): readonly string[] {
  const candidates: string[] = [];
  for (const [key, def] of Object.entries(shape)) {
    if (key === pk) continue;
    if (def.reference !== undefined) continue;
    if (def.kind !== "string" && def.kind !== "enum") continue;
    candidates.push(key);
    if (candidates.length === 2) break;
  }
  return candidates;
}

/**
 * A Map key identifying a schema path. Serializing the whole array keeps
 * segments apart without inventing a separator that a column name could
 * legitimately contain.
 */
function pathKey(path: Path): string {
  return JSON.stringify(path);
}

/** Walks a column definition and collects every foreign key inside it. */
function collectReferences(
  columnKey: string,
  def: ColumnDef,
  resolve: (path: Path) => { table: string; column: string } | undefined,
): StudioReference[] {
  const found: StudioReference[] = [];

  const visit = (current: ColumnDef, path: Path): void => {
    if (current.reference !== undefined) {
      const target = resolve(path);
      if (target !== undefined) {
        found.push({
          path,
          pathString: formatPath(path),
          column: columnKey,
          topLevel: path.length === 1,
          targetTable: target.table,
          targetColumn: target.column,
        });
      }
    }
    if (current.kind === "array" && current.element !== undefined) {
      visit(current.element, [...path, "[]"]);
    }
    if (current.kind === "object" && current.shape !== undefined) {
      for (const [childKey, childDef] of Object.entries(current.shape)) {
        visit(childDef, [...path, childKey]);
      }
    }
  };

  visit(def, [columnKey]);
  return found;
}

export interface BuildMetaOptions {
  readonly readOnly: boolean;
  /** Same mapping loadTablesFromDir uses, so the UI can show the backing file */
  readonly fileFor: (tableKey: string) => string;
}

/**
 * Builds the full studio payload for a schema. The reference graph is walked
 * twice: once to flatten every outgoing FK, then once more to invert it into
 * the referencedBy lists that power the "who points at this row" panel.
 */
export function buildStudioMeta(schema: AnySchema, options: BuildMetaOptions): StudioMeta {
  const referencesByTable = new Map<string, StudioReference[]>();

  for (const [tableKey, table] of schema._.tables) {
    // defineSchema already resolved every FK; index them by path so the walk
    // over the shape can look up the target it settled on.
    const resolved = new Map<string, { table: string; column: string }>();
    for (const ref of constraintsOf(schema, tableKey).references) {
      resolved.set(pathKey(ref.path), {
        table: ref.target.tableKey,
        column: ref.target.columnKey,
      });
    }
    const resolve = (path: Path) => resolved.get(pathKey(path));

    const all: StudioReference[] = [];
    for (const [columnKey, def] of Object.entries(table._.shape)) {
      all.push(...collectReferences(columnKey, def, resolve));
    }
    referencesByTable.set(tableKey, all);
  }

  const incomingByTable = new Map<string, StudioIncomingReference[]>();
  for (const tableKey of schema._.tables.keys()) {
    incomingByTable.set(tableKey, []);
  }
  for (const [fromTable, references] of referencesByTable) {
    for (const ref of references) {
      incomingByTable.get(ref.targetTable)?.push({
        fromTable,
        path: ref.path,
        pathString: ref.pathString,
        column: ref.targetColumn,
      });
    }
  }

  const tables: StudioTableMeta[] = [];
  for (const [tableKey, table] of schema._.tables) {
    const constraints = constraintsOf(schema, tableKey);
    const references = referencesByTable.get(tableKey) ?? [];
    const nestedByColumn = new Map<string, StudioReference[]>();
    const topLevelByColumn = new Map<string, StudioReference>();
    for (const ref of references) {
      if (ref.topLevel) {
        topLevelByColumn.set(ref.column, ref);
        continue;
      }
      const list = nestedByColumn.get(ref.column);
      if (list === undefined) {
        nestedByColumn.set(ref.column, [ref]);
      } else {
        list.push(ref);
      }
    }

    const columns: StudioColumnMeta[] = Object.entries(table._.shape).map(([key, def]) => {
      const topLevel = topLevelByColumn.get(key);
      return {
        key,
        kind: def.kind,
        nullable: def.nullable,
        optional: def.optional,
        primaryKey: def.primaryKey,
        unique: def.unique,
        ...(def.enumValues === undefined ? {} : { enumValues: def.enumValues }),
        typeLabel: typeLabelOf(def),
        ...(topLevel === undefined
          ? {}
          : { reference: { table: topLevel.targetTable, column: topLevel.targetColumn } }),
        nestedReferences: nestedByColumn.get(key) ?? [],
        composite: def.kind === "array" || def.kind === "object",
      };
    });

    tables.push({
      key: tableKey,
      name: table._.name,
      file: options.fileFor(tableKey),
      pk: constraints.pk,
      uniques: constraints.uniques,
      columns,
      references,
      referencedBy: incomingByTable.get(tableKey) ?? [],
      labelColumns: labelColumnsOf(table._.shape, constraints.pk),
    });
  }

  return { tables, readOnly: options.readOnly };
}

/** Builds an empty row for a table, so "new row" starts from the declared shape. */
export function blankRow(schema: AnySchema, tableKey: string): Record<string, unknown> {
  const table = schema._.tables.get(tableKey);
  if (table === undefined) return {};
  const row: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(table._.shape)) {
    if (def.optional) continue;
    row[key] = blankValue(def);
  }
  return row;
}

function blankValue(def: ColumnDef): unknown {
  if (def.nullable) return null;
  switch (def.kind) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "enum":
      return def.enumValues?.[0] ?? "";
    case "array":
      return [];
    case "object": {
      const nested: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        if (child.optional) continue;
        nested[key] = blankValue(child);
      }
      return nested;
    }
  }
}

/** The schema keys of a schema, in declaration order. */
export function tableKeysOf(schema: AnySchema): readonly string[] {
  return [...schema._.tables.keys()];
}
