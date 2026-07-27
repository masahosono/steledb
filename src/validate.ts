import type { ColumnDef } from "./column.js";
import {
  JsonRdbError,
  type ValidationError,
  type ValidationErrorBase,
  formatErrorPath,
} from "./errors.js";
import { type PathHit, collectAtPath, isPlainObject } from "./paths.js";
import {
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
   * How to treat keys that are absent from the schema. Defaults to "error".
   * Useful for catching typos in hand-written data, or fields an AI added on its own.
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

/** Renders a value compactly for an error message. */
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

/** The validation context for a single table. Builds row labels and collects errors. */
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
        // displayAs can fail on a row with a broken shape, so fall through
      }
    }
    const rowKey = this.rowKeyOf(row);
    return rowKey !== null ? `(${this.pkColumn}=${rowKey})` : `(row ${rowIndex})`;
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

  /** Validates the shape of every row and reports per-row results (broken rows skip relational checks). */
  validateShape(): boolean[] {
    return this.rows.map((row, rowIndex) => {
      if (!isPlainObject(row)) {
        this.addError(rowIndex, [], `the row is not an object (actual: ${show(row)})`, {
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
      this.addError(rowIndex, path, `null is not allowed (expected: ${describeType(def)})`, {
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
          `the value is not allowed (expected: ${describeType(def)}, actual: ${show(value)})`,
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
      // JSON has no undefined, so a missing key and an undefined value are the same thing
      if (!(key in obj) || obj[key] === undefined) {
        if (childDef.optional) continue;
        this.addError(
          rowIndex,
          [...path, key],
          `a required key is missing (expected: ${describeType(childDef)})`,
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
          this.addError(rowIndex, [...path, key], `key "${key}" is not defined in the schema`, {
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
      `type mismatch (expected: ${describeType(def)}, actual: ${show(value)})`,
      { code: "SHAPE_MISMATCH", expected: describeType(def), actual: value },
    );
  }

  /** Detects duplicates in unique / primaryKey columns. Multiple nulls are fine. */
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
          `duplicate ${column} ${show(value)} (same value as row ${other})`,
          { code: "DUPLICATE_KEY", column, value, otherRowIndex: other },
        );
      });
    }
  }

  /** Checks that foreign keys resolve. null and missing values are skipped (nullable / optional FKs). */
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
            `${show(hit.value)} does not exist in ${ref.target.tableKey}.${ref.target.columnKey}`,
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

  /** Checks denormalized fields against their source (strict, or alias-tolerant). */
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
          // Nothing to check when the value or the FK is null / missing. A dangling FK is already reported as FK_VIOLATION
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
            ? `${show(actual)} does not match ${refKeyPath} ${show(expected)} and is not contained in ${mm.orIn.columnKey}`
            : `${show(actual)} does not match ${refKeyPath} ${show(expected)}`;
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

  /** Checks composite uniqueness scoped to the parent record (uniqueBy). */
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
              `duplicate key ${serialized} within ${formatPath(ub.path)} (elements ${other} and ${index})`,
              { code: "SCOPED_DUPLICATE", scopePath: formatPath(ub.path), key: keyArray },
            );
          });
        }
      });
    }
  }

  /** Runs the custom checks declared on the table. */
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
          detail = `the check threw an exception: ${String(cause)}`;
        }
        if (typeof detail === "string") {
          this.addError(rowIndex, [], detail, { code: "CHECK_FAILED", detail });
        }
      }
    });
  }
}

/**
 * Validates data against every constraint in the schema. It does not fail fast:
 * all errors are collected and returned. Rows with a broken shape skip the
 * relational checks (FK, mustMatch, and so on) to keep the noise down.
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
        `data for table "${tableKey}" is not an array (data keys: ${Object.keys(dataRecord).join(", ")})`,
      );
    }
  }

  // 1) Shape validation (per-row results are kept so broken rows can be excluded from relational checks)
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

  // 2) Value indexes for referenced columns (built lazily, only for targets that are needed)
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

  // 3) Constraint validation
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
