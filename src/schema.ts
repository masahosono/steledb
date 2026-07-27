import type { ColumnDef } from "./column.js";
import { JsonRdbError } from "./errors.js";
import { type AnyTable, ColumnRef } from "./table.js";

export type SchemaTables = Record<string, AnyTable>;

/**
 * The return value of defineSchema(). Tables are reachable directly, as in
 * `schema.songs`. `_` is reserved for metadata (so it cannot be a schema key).
 */
export type Schema<S extends SchemaTables> = { readonly [K in keyof S]: S[K] } & SchemaBrand;

export interface SchemaBrand {
  readonly _: SchemaMeta;
}

export type AnySchema = SchemaBrand;

/** Data injected into a schema. Keys map 1:1 to schema keys (any mismatch is a compile error). */
export type TablesData<S extends SchemaTables> = { readonly [K in keyof S]: readonly unknown[] };

export interface SchemaMeta {
  /** Schema key to table */
  readonly tables: ReadonlyMap<string, AnyTable>;
  /** Table to schema key (used to look up a table from a ColumnRef) */
  readonly keyByTable: ReadonlyMap<AnyTable, string>;
  /** Schema key to resolved constraints */
  readonly constraints: ReadonlyMap<string, TableConstraints>;
}

export interface ResolvedColumn {
  readonly tableKey: string;
  readonly columnKey: string;
}

/**
 * A path is the sequence of segments locating something inside a shape. It is
 * made of string keys plus the marker "[]" for array elements
 * (e.g. ["coveredEvents", "[]", "tracks", "[]", "songId"]).
 */
export type Path = readonly string[];

export interface ReferenceConstraint {
  readonly path: Path;
  readonly target: ResolvedColumn;
}

export interface MustMatchConstraint {
  /** Path of the denormalized field itself */
  readonly path: Path;
  /** Name of the FK field in the same scope */
  readonly via: string;
  /** What via points at (the lookup key for the master row) */
  readonly viaTarget: ResolvedColumn;
  /** The master column the value has to match */
  readonly target: ResolvedColumn;
  /** Master-side array column consulted in alias-tolerant mode */
  readonly orIn?: ResolvedColumn;
}

export interface UniqueByConstraint {
  /** Path of the array column this applies to */
  readonly path: Path;
  readonly key: (element: never) => unknown;
}

export interface TableConstraints {
  /** Column keys forming the primary key: one for a simple key, several for a composite one */
  readonly pk: readonly string[] | null;
  /** Top-level column keys declared unique (the PK included) */
  readonly uniques: readonly string[];
  /** Table-level composite unique constraints, as lists of top-level column keys */
  readonly compositeUniques: readonly (readonly string[])[];
  readonly references: readonly ReferenceConstraint[];
  readonly mustMatches: readonly MustMatchConstraint[];
  readonly uniqueBys: readonly UniqueByConstraint[];
}

/** Renders a path for display, as "coveredEvents[].tracks[].songId". */
export function formatPath(path: Path): string {
  let out = "";
  for (const seg of path) {
    if (seg === "[]") {
      out += "[]";
    } else {
      out += out === "" ? seg : `.${seg}`;
    }
  }
  return out;
}

const SCALAR_KINDS: ReadonlySet<string> = new Set(["string", "number", "boolean", "enum"]);

/**
 * Turns the column references a table-level constraint was declared with into
 * this table's own top-level column keys, rejecting what the type system cannot
 * catch on its own (a borrowed column, a repeated member, a non-scalar column).
 */
function resolveSelfColumns(tbl: AnyTable, members: readonly unknown[], at: string): string[] {
  const columns: string[] = [];
  for (const member of members) {
    if (!(member instanceof ColumnRef)) {
      throw new JsonRdbError(`${at}: expected a column reference of "${tbl._.name}" itself`);
    }
    if (member.table !== tbl) {
      throw new JsonRdbError(
        `${at}: "${member.table._.name}.${member.key}" belongs to another table (a table-level constraint can only use this table's own columns)`,
      );
    }
    if (!SCALAR_KINDS.has(member.def.kind)) {
      throw new JsonRdbError(
        `${at}: "${member.key}" is ${member.def.kind}, and only scalar columns can take part in a key`,
      );
    }
    if (columns.includes(member.key)) {
      throw new JsonRdbError(`${at}: "${member.key}" appears more than once`);
    }
    columns.push(member.key);
  }
  return columns;
}

/**
 * Settles the primary key of a table: the column marked .primaryKey(), or the
 * composite one declared in the table config. Declaring both is an error, since
 * a table has at most one primary key.
 */
function resolvePrimaryKey(tbl: AnyTable, columnPk: string | null): readonly string[] | null {
  const declared = tbl._.config.primaryKey;
  if (declared === undefined) return columnPk === null ? null : [columnPk];

  const at = `table "${tbl._.name}": primaryKey`;
  if (columnPk !== null) {
    throw new JsonRdbError(
      `${at}: the config declares a primary key while column "${columnPk}" is marked .primaryKey() as well (a table has at most one)`,
    );
  }
  if (!Array.isArray(declared)) {
    throw new JsonRdbError(`${at}: expected a list of columns (e.g. primaryKey: [self.a, self.b])`);
  }
  const columns = resolveSelfColumns(tbl, declared, at);
  if (columns.length < 2) {
    throw new JsonRdbError(
      `${at}: a composite primary key needs two or more columns (for a single column use .primaryKey() on the column itself)`,
    );
  }
  for (const column of columns) {
    const def = tbl._.shape[column];
    if (def?.nullable === true || def?.optional === true) {
      throw new JsonRdbError(
        `${at}: "${column}" is ${def.nullable ? "nullable" : "optional"}, and every member of a primary key has to carry a value`,
      );
    }
  }
  return columns;
}

/**
 * Resolves the composite unique constraints declared in the table config. A
 * composite primary key is one of them, mirroring how .primaryKey() on a column
 * implies .unique().
 */
function resolveCompositeUniques(
  tbl: AnyTable,
  pk: readonly string[] | null,
): readonly (readonly string[])[] {
  const resolved: (readonly string[])[] = [];
  const seen = new Set<string>();
  let pkKey: string | null = null;
  if (pk !== null && pk.length > 1) {
    pkKey = JSON.stringify(pk);
    seen.add(pkKey);
    resolved.push(pk);
  }

  const declared = tbl._.config.unique;
  if (declared === undefined) return resolved;

  declared.forEach((members: unknown, index: number) => {
    const at = `table "${tbl._.name}": unique[${index}]`;
    if (!Array.isArray(members)) {
      throw new JsonRdbError(
        `${at}: expected a list of columns (one composite key is written as unique: [[a, b]])`,
      );
    }
    const columns = resolveSelfColumns(tbl, members, at);
    if (columns.length < 2) {
      throw new JsonRdbError(
        `${at}: a composite unique needs two or more columns (for a single column use .unique() on the column itself)`,
      );
    }
    const key = JSON.stringify(columns);
    if (key === pkKey) {
      throw new JsonRdbError(
        `${at}: (${columns.join(", ")}) is already the primary key, which forbids duplicates on its own`,
      );
    }
    if (seen.has(key)) {
      throw new JsonRdbError(`${at}: (${columns.join(", ")}) is declared more than once`);
    }
    seen.add(key);
    resolved.push(columns);
  });

  return resolved;
}

/**
 * Freezes a schema. Every references / mustMatch thunk is resolved here, and the
 * invariants the type system cannot guard (the via sibling existing, FK targets
 * being unique, at most one PK, and so on) are checked at runtime. A broken
 * schema therefore fails the moment it is imported.
 */
export function defineSchema<S extends SchemaTables>(tables: S): Schema<S> {
  const tableMap = new Map<string, AnyTable>();
  const keyByTable = new Map<AnyTable, string>();
  const nameToKey = new Map<string, string>();

  for (const [key, tbl] of Object.entries(tables)) {
    if (key === "_" || key.startsWith("~") || key.startsWith("$")) {
      throw new JsonRdbError(
        `schema key "${key}" is not allowed ("_" and names starting with "~" or "$" are reserved)`,
      );
    }
    if (keyByTable.has(tbl)) {
      throw new JsonRdbError(
        `table "${tbl._.name}" is registered under both schema keys "${keyByTable.get(tbl)}" and "${key}"`,
      );
    }
    if (nameToKey.has(tbl._.name)) {
      throw new JsonRdbError(`duplicate table name "${tbl._.name}"`);
    }
    tableMap.set(key, tbl);
    keyByTable.set(tbl, key);
    nameToKey.set(tbl._.name, key);
  }

  /** Resolves the bound column returned by a thunk into { tableKey, columnKey }. */
  function resolveThunk(get: () => unknown, context: string): ResolvedColumn {
    const ref = get();
    if (!(ref instanceof ColumnRef)) {
      throw new JsonRdbError(
        `${context}: the thunk returned something other than a column reference`,
      );
    }
    const tableKey = keyByTable.get(ref.table);
    if (tableKey === undefined) {
      throw new JsonRdbError(
        `${context}: referenced table "${ref.table._.name}" is not registered in the schema`,
      );
    }
    return { tableKey, columnKey: ref.key };
  }

  function resolveNamed(tableName: string, columnKey: string, context: string): ResolvedColumn {
    const tableKey = tableMap.has(tableName) ? tableName : nameToKey.get(tableName);
    if (tableKey === undefined) {
      throw new JsonRdbError(
        `${context}: referenced table "${tableName}" does not exist in the schema` +
          ` (registered: ${[...tableMap.keys()].join(", ")})`,
      );
    }
    const target = tableMap.get(tableKey);
    if (target === undefined || !(columnKey in target._.shape)) {
      throw new JsonRdbError(
        `${context}: referenced column "${tableName}.${columnKey}" does not exist`,
      );
    }
    return { tableKey, columnKey };
  }

  function defAt(resolved: ResolvedColumn): ColumnDef {
    const def = tableMap.get(resolved.tableKey)?._.shape[resolved.columnKey];
    if (def === undefined) {
      throw new JsonRdbError(
        `internal error: no definition found for resolved column ${resolved.tableKey}.${resolved.columnKey}`,
      );
    }
    return def;
  }

  const constraints = new Map<string, TableConstraints>();

  for (const [key, tbl] of tableMap) {
    const references: ReferenceConstraint[] = [];
    const mustMatches: MustMatchConstraint[] = [];
    const uniqueBys: UniqueByConstraint[] = [];
    let columnPk: string | null = null;
    const uniques: string[] = [];

    const visit = (
      def: ColumnDef,
      path: Path,
      scope: Readonly<Record<string, ColumnDef>> | null,
    ): void => {
      const at = `${tbl._.name}.${formatPath(path)}`;
      const isTopLevel = path.length === 1;

      if (!isTopLevel && (def.primaryKey || def.unique)) {
        throw new JsonRdbError(
          `${at}: primaryKey / unique can only be applied to top-level columns (use uniqueBy to forbid duplicates inside a nested array)`,
        );
      }
      if (isTopLevel) {
        const columnKey = path[0] as string;
        if (def.primaryKey) {
          if (columnPk !== null) {
            throw new JsonRdbError(
              `table "${tbl._.name}": multiple primaryKey columns ("${columnPk}" and "${columnKey}")`,
            );
          }
          columnPk = columnKey;
        }
        if (def.unique) {
          uniques.push(columnKey);
        }
      }

      if (def.reference) {
        const target =
          def.reference.form === "thunk"
            ? resolveThunk(def.reference.get, `${at} references`)
            : resolveNamed(def.reference.table, def.reference.column, `${at} references`);
        const targetDef = defAt(target);
        if (!targetDef.unique) {
          throw new JsonRdbError(
            `${at} references: target ${target.tableKey}.${target.columnKey} is not unique (a foreign key must point at a primaryKey or unique column)`,
          );
        }
        references.push({ path, target });
      }

      if (def.mustMatch) {
        if (!SCALAR_KINDS.has(def.kind)) {
          throw new JsonRdbError(`${at}: mustMatch can only be applied to scalar columns`);
        }
        if (scope === null) {
          throw new JsonRdbError(
            `${at}: mustMatch can only be applied to a field inside an object scope (because via refers to a sibling FK field)`,
          );
        }
        const viaDef = scope[def.mustMatch.via];
        if (viaDef === undefined) {
          throw new JsonRdbError(
            `${at} mustMatch: via "${def.mustMatch.via}" does not exist in the same scope` +
              ` (available fields: ${Object.keys(scope).join(", ")})`,
          );
        }
        if (viaDef.reference === undefined) {
          throw new JsonRdbError(`${at} mustMatch: via "${def.mustMatch.via}" has no references`);
        }
        const viaTarget =
          viaDef.reference.form === "thunk"
            ? resolveThunk(viaDef.reference.get, `${at} mustMatch (references of via)`)
            : resolveNamed(
                viaDef.reference.table,
                viaDef.reference.column,
                `${at} mustMatch (references of via)`,
              );
        const target = resolveThunk(def.mustMatch.target, `${at} mustMatch`);
        if (target.tableKey !== viaTarget.tableKey) {
          throw new JsonRdbError(
            `${at} mustMatch: target (${target.tableKey}.${target.columnKey}) and ` +
              `the target of via (${viaTarget.tableKey}.${viaTarget.columnKey}) belong to different tables`,
          );
        }
        let orIn: ResolvedColumn | undefined;
        if (def.mustMatch.orIn) {
          orIn = resolveThunk(def.mustMatch.orIn, `${at} mustMatch (orIn)`);
          if (orIn.tableKey !== target.tableKey) {
            throw new JsonRdbError(
              `${at} mustMatch: orIn (${orIn.tableKey}.${orIn.columnKey}) is not in the same table as target`,
            );
          }
          if (defAt(orIn).kind !== "array") {
            throw new JsonRdbError(
              `${at} mustMatch: orIn (${orIn.tableKey}.${orIn.columnKey}) must be an array column`,
            );
          }
        }
        mustMatches.push(
          orIn === undefined
            ? { path, via: def.mustMatch.via, viaTarget, target }
            : { path, via: def.mustMatch.via, viaTarget, target, orIn },
        );
      }

      if (def.uniqueBy) {
        uniqueBys.push({ path, key: def.uniqueBy });
      }

      if (def.kind === "array" && def.element) {
        visit(def.element, [...path, "[]"], null);
      }
      if (def.kind === "object" && def.shape) {
        for (const [childKey, childDef] of Object.entries(def.shape)) {
          if (childKey === "_" || childKey.startsWith("~") || childKey.startsWith("$")) {
            throw new JsonRdbError(
              `${at}: nested field name "${childKey}" is not allowed ("_" and names starting with "~" or "$" are reserved)`,
            );
          }
          visit(childDef, [...path, childKey], def.shape);
        }
      }
    };

    for (const [columnKey, def] of Object.entries(tbl._.shape)) {
      visit(def, [columnKey], tbl._.shape);
    }

    const pk = resolvePrimaryKey(tbl, columnPk);
    constraints.set(key, {
      pk,
      uniques,
      compositeUniques: resolveCompositeUniques(tbl, pk),
      references,
      mustMatches,
      uniqueBys,
    });
  }

  const schema = { ...tables } as Record<string, unknown>;
  const meta: SchemaMeta = { tables: tableMap, keyByTable, constraints };
  Object.defineProperty(schema, "_", { value: meta, enumerable: false });
  return Object.freeze(schema) as Schema<S>;
}

/** Looks up a table's resolved constraints by schema key (throws for an unknown key). */
export function constraintsOf(schema: AnySchema, tableKey: string): TableConstraints {
  const constraints = schema._.constraints.get(tableKey);
  if (constraints === undefined) {
    throw new JsonRdbError(`table key "${tableKey}" does not exist in the schema`);
  }
  return constraints;
}
