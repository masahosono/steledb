/**
 * クエリ式の基底型。ランタイム表現は `kind` で判別されるプレーンオブジェクトで、
 * `~data` は式の評価結果型を運ぶ phantom プロパティ（実行時には存在しない）。
 */
export interface Expr<T = unknown> {
  readonly kind: string;
  readonly "~data"?: T;
}

/** orderBy の 1 キー。null の並び位置は SQL の NULLS FIRST/LAST に相当する。 */
export interface OrderSpec {
  readonly expr: Expr;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface OrderOptions {
  /** null 値を先頭に置くか末尾に置くか。省略時は "last"。 */
  readonly nulls?: "first" | "last";
}

export function asc(expr: Expr, options: OrderOptions = {}): OrderSpec {
  return { expr, direction: "asc", nulls: options.nulls ?? "last" };
}

export function desc(expr: Expr, options: OrderOptions = {}): OrderSpec {
  return { expr, direction: "desc", nulls: options.nulls ?? "last" };
}
