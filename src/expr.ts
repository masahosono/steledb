import type { ColumnDef } from "./column.js";
import { JsonRdbError } from "./errors.js";

/**
 * The symbol key holding the actual expression node. String properties of an
 * expression object are used as accessors (field references inside some(), for
 * example), so hiding the node itself behind a symbol keeps it from colliding
 * with field names in the data (such as "kind").
 */
export const EXPR: unique symbol = Symbol("steledb.expr");

export type ExprNode =
  | {
      readonly kind: "column";
      readonly table: object;
      readonly key: string;
      readonly def: ColumnDef;
    }
  | {
      readonly kind: "field";
      readonly source: object;
      readonly path: readonly string[];
      readonly def: ColumnDef | undefined;
    }
  | { readonly kind: "literal"; readonly value: unknown }
  | {
      readonly kind: "binary";
      readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      readonly left: Expr;
      readonly right: Expr;
    }
  | {
      readonly kind: "inArray";
      readonly expr: Expr;
      readonly values: readonly unknown[];
      readonly negate: boolean;
    }
  | { readonly kind: "nullCheck"; readonly expr: Expr; readonly negate: boolean }
  | {
      readonly kind: "logical";
      readonly op: "and" | "or";
      readonly operands: readonly Expr<boolean>[];
    }
  | { readonly kind: "not"; readonly operand: Expr<boolean> }
  | {
      readonly kind: "some";
      readonly array: Expr;
      readonly token: object;
      readonly predicate: Expr<boolean>;
    }
  | { readonly kind: "arrayContains"; readonly array: Expr; readonly value: Expr };

/**
 * A query expression. `~data` is a phantom property carrying the result type of
 * the evaluation; it does not exist at runtime.
 */
export interface Expr<T = unknown> {
  readonly [EXPR]: ExprNode;
  readonly "~data"?: T;
}

export function isExpr(value: unknown): value is Expr {
  return typeof value === "object" && value !== null && EXPR in value;
}

function makeExpr<T>(node: ExprNode): Expr<T> {
  return { [EXPR]: node } as Expr<T>;
}

function toExpr(value: unknown): Expr {
  return isExpr(value) ? value : makeExpr({ kind: "literal", value });
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function binary<T>(
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte",
  left: Expr<T>,
  right: unknown,
): Expr<boolean> {
  return makeExpr({ kind: "binary", op, left, right: toExpr(right) });
}

export function eq<T>(left: Expr<T>, right: NoInfer<T> | Expr<T>): Expr<boolean> {
  return binary("eq", left, right);
}
export function ne<T>(left: Expr<T>, right: NoInfer<T> | Expr<T>): Expr<boolean> {
  return binary("ne", left, right);
}
export function gt<T>(left: Expr<T>, right: NoInfer<T> | Expr<T>): Expr<boolean> {
  return binary("gt", left, right);
}
export function gte<T>(left: Expr<T>, right: NoInfer<T> | Expr<T>): Expr<boolean> {
  return binary("gte", left, right);
}
export function lt<T>(left: Expr<T>, right: NoInfer<T> | Expr<T>): Expr<boolean> {
  return binary("lt", left, right);
}
export function lte<T>(left: Expr<T>, right: NoInfer<T> | Expr<T>): Expr<boolean> {
  return binary("lte", left, right);
}

export function inArray<T>(expr: Expr<T>, values: readonly NoInfer<T>[]): Expr<boolean> {
  return makeExpr({ kind: "inArray", expr, values, negate: false });
}
export function notInArray<T>(expr: Expr<T>, values: readonly NoInfer<T>[]): Expr<boolean> {
  return makeExpr({ kind: "inArray", expr, values, negate: true });
}

export function isNull(expr: Expr<unknown>): Expr<boolean> {
  return makeExpr({ kind: "nullCheck", expr, negate: false });
}
export function isNotNull(expr: Expr<unknown>): Expr<boolean> {
  return makeExpr({ kind: "nullCheck", expr, negate: true });
}

export function and(first: Expr<boolean>, ...rest: Expr<boolean>[]): Expr<boolean> {
  return makeExpr({ kind: "logical", op: "and", operands: [first, ...rest] });
}
export function or(first: Expr<boolean>, ...rest: Expr<boolean>[]): Expr<boolean> {
  return makeExpr({ kind: "logical", op: "or", operands: [first, ...rest] });
}
export function not(operand: Expr<boolean>): Expr<boolean> {
  return makeExpr({ kind: "not", operand });
}

/**
 * The typed accessor handed to the element predicate of some(). When the element
 * is an object its fields can be walked as properties. Array fields stop at Expr;
 * going deeper requires a nested some().
 */
export type FieldRefs<E> = Expr<E> &
  ([NonNullable<E>] extends [readonly unknown[]]
    ? unknown
    : [NonNullable<E>] extends [Record<string, unknown>]
      ? { readonly [K in keyof NonNullable<E> & string]-?: FieldRefs<NonNullable<E>[K]> }
      : unknown);

/** Builds a field accessor (an expression node plus child properties) from a ColumnDef. */
export function makeFieldRefs(
  def: ColumnDef | undefined,
  source: object,
  path: readonly string[],
): Expr<unknown> {
  const node: Record<string, unknown> & { [EXPR]: ExprNode } = {
    [EXPR]: { kind: "field", source, path, def },
  };
  if (def?.kind === "object" && def.shape) {
    for (const [key, child] of Object.entries(def.shape)) {
      node[key] = makeFieldRefs(child, source, [...path, key]);
    }
  }
  return node;
}

/**
 * Whether any element of an array column satisfies the predicate.
 * Example: `some(songs.artists, (a) => eq(a.id, artistId))`
 */
export function some<E>(
  array: Expr<readonly E[]> | Expr<readonly E[] | undefined> | Expr<readonly E[] | null>,
  predicate: (element: FieldRefs<E>) => Expr<boolean>,
): Expr<boolean> {
  const token = {};
  const elementDef =
    array[EXPR].kind === "column" || array[EXPR].kind === "field"
      ? array[EXPR].def?.element
      : undefined;
  const accessor = makeFieldRefs(elementDef, token, []) as FieldRefs<E>;
  return makeExpr({ kind: "some", array, token, predicate: predicate(accessor) });
}

/**
 * Whether a scalar array column contains a value.
 * Example: `arrayContains(videos.coveredLiveIds, liveId)`
 */
export function arrayContains<T>(
  array: Expr<readonly T[]>,
  value: NoInfer<T> | Expr<T>,
): Expr<boolean> {
  return makeExpr({ kind: "arrayContains", array, value: toExpr(value) });
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Query source (a table, or the token of a some/unnest) to the current row or element. */
export type Bindings = ReadonlyMap<object, unknown>;

function normalizeNull(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function evaluate(expr: Expr, bindings: Bindings): unknown {
  const node = expr[EXPR];
  switch (node.kind) {
    case "column": {
      if (!bindings.has(node.table)) {
        const name = (node.table as { _?: { name?: string } })._?.name ?? "?";
        throw new JsonRdbError(
          `column "${node.key}" of table "${name}" is not among this query's sources`,
        );
      }
      const row = bindings.get(node.table);
      return row === null || row === undefined
        ? undefined
        : (row as Record<string, unknown>)[node.key];
    }
    case "field": {
      if (!bindings.has(node.source)) {
        throw new JsonRdbError("the element reference is not in scope for this query");
      }
      let value = bindings.get(node.source);
      for (const segment of node.path) {
        if (value === null || value === undefined) return undefined;
        value = (value as Record<string, unknown>)[segment];
      }
      return value;
    }
    case "literal":
      return node.value;
    case "binary": {
      const left = normalizeNull(evaluate(node.left, bindings));
      const right = normalizeNull(evaluate(node.right, bindings));
      switch (node.op) {
        case "eq":
          return left === right;
        case "ne":
          return left !== right;
        default: {
          // An ordering comparison involving null / undefined is always false, as with SQL NULLs
          if (left === null || right === null) return false;
          switch (node.op) {
            case "gt":
              return (left as never) > (right as never);
            case "gte":
              return (left as never) >= (right as never);
            case "lt":
              return (left as never) < (right as never);
            case "lte":
              return (left as never) <= (right as never);
          }
        }
      }
      break;
    }
    case "inArray": {
      const value = normalizeNull(evaluate(node.expr, bindings));
      const found = node.values.some((candidate) => normalizeNull(candidate) === value);
      return node.negate ? !found : found;
    }
    case "nullCheck": {
      const value = evaluate(node.expr, bindings);
      const isNullish = value === null || value === undefined;
      return node.negate ? !isNullish : isNullish;
    }
    case "logical": {
      if (node.op === "and") {
        return node.operands.every((operand) => evaluate(operand, bindings) === true);
      }
      return node.operands.some((operand) => evaluate(operand, bindings) === true);
    }
    case "not":
      return evaluate(node.operand, bindings) !== true;
    case "some": {
      const array = evaluate(node.array, bindings);
      if (!Array.isArray(array)) return false;
      return array.some((element) => {
        const child = new Map(bindings);
        child.set(node.token, element);
        return evaluate(node.predicate, child) === true;
      });
    }
    case "arrayContains": {
      const array = evaluate(node.array, bindings);
      if (!Array.isArray(array)) return false;
      const value = normalizeNull(evaluate(node.value, bindings));
      return array.some((element) => normalizeNull(element) === value);
    }
  }
  throw new JsonRdbError("unknown expression node");
}

// ---------------------------------------------------------------------------
// orderBy
// ---------------------------------------------------------------------------

/** One orderBy key. Where nulls land corresponds to SQL's NULLS FIRST/LAST. */
export interface OrderSpec {
  readonly expr: Expr;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface OrderOptions {
  /** Whether nulls go first or last. Defaults to "last". */
  readonly nulls?: "first" | "last";
}

export function asc(expr: Expr, options: OrderOptions = {}): OrderSpec {
  return { expr, direction: "asc", nulls: options.nulls ?? "last" };
}

export function desc(expr: Expr, options: OrderOptions = {}): OrderSpec {
  return { expr, direction: "desc", nulls: options.nulls ?? "last" };
}

/** Compares two values per an OrderSpec. null / undefined follow the nulls setting. */
export function compareBySpec(a: unknown, b: unknown, spec: OrderSpec): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    // Where nulls land does not depend on direction, as with SQL NULLS FIRST/LAST
    const nullRank = spec.nulls === "first" ? -1 : 1;
    return aNull ? nullRank : -nullRank;
  }
  let result = 0;
  if ((a as never) < (b as never)) result = -1;
  else if ((a as never) > (b as never)) result = 1;
  return spec.direction === "desc" ? -result : result;
}
