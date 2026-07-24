import type { ColMeta, Simplify } from "./column.js";
import { JsonRdbError } from "./errors.js";
import {
  type Bindings,
  EXPR,
  type Expr,
  type FieldRefs,
  type OrderSpec,
  asc,
  compareBySpec,
  evaluate,
  isExpr,
  makeFieldRefs,
} from "./expr.js";
import { type AnyTable, type ColumnRef, type InferRow, type TableName, isTable } from "./table.js";

/**
 * 射影の指定。値にはカラム参照・式（→ その評価値）か、テーブル実体
 * （→ 行を丸ごと）を置ける。
 */
export type Projection = Record<string, AnyTable | Expr<any>>;

export type ResolveProjection<P extends Projection> = Simplify<{
  [K in keyof P]: P[K] extends AnyTable ? InferRow<P[K]> : P[K] extends Expr<infer T> ? T : never;
}>;

export type SelectedRow<P extends Projection | undefined, TFromRow> = P extends Projection
  ? ResolveProjection<P>
  : TFromRow;

/**
 * leftJoin されたテーブルを丸ごと射影しているエントリを `| null` にする。
 * v1 の意図的な妥協: 個別カラム射影の nullable 化は行わない（テーブル名の
 * リテラル一致で判定できる「テーブル丸ごと」エントリのみ）。
 */
export type NullifyProjected<
  TRow,
  P extends Projection | undefined,
  T extends AnyTable,
> = P extends Projection
  ? Simplify<{
      [K in keyof TRow]: K extends keyof P
        ? P[K] extends AnyTable
          ? TableName<P[K]> extends TableName<T>
            ? TRow[K] | null
            : TRow[K]
          : TRow[K]
        : TRow[K];
    }>
  : TRow;

// ---------------------------------------------------------------------------
// unnest
// ---------------------------------------------------------------------------

export const UNNEST: unique symbol = Symbol("steledb.unnest");

export interface UnnestMeta {
  readonly parentTable: AnyTable;
  readonly arrayKey: string;
  /** バインディングのキー: 現在の配列要素 */
  readonly elementToken: object;
  /** バインディングのキー: 配列内インデックス */
  readonly indexToken: object;
}

/**
 * unnest() が返す仮想テーブル。要素のフィールドをプロパティとして辿れるほか、
 * `$`（要素全体）/ `$index`（配列内位置）/ `$parent`（親テーブルのカラム参照）
 * を持つ。`~element` は要素型を運ぶ phantom。
 */
export type UnnestSource<E, TParentRow> = {
  readonly [UNNEST]: UnnestMeta;
  readonly "~element"?: E;
  readonly $: Expr<E>;
  readonly $index: Expr<number>;
  readonly $parent: { readonly [K in keyof TParentRow & string]-?: Expr<TParentRow[K]> };
} & ([NonNullable<E>] extends [Record<string, unknown>]
  ? { readonly [K in keyof NonNullable<E> & string]-?: FieldRefs<NonNullable<E>[K]> }
  : unknown);

export interface AnyUnnestSource {
  readonly [UNNEST]: UnnestMeta;
  readonly "~element"?: unknown;
}

export function isUnnestSource(value: unknown): value is AnyUnnestSource {
  return typeof value === "object" && value !== null && UNNEST in value;
}

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

/**
 * トップレベルの配列カラムを「1 要素 = 1 行」の仮想テーブルに展開する。
 * SQL の unnest / CROSS JOIN LATERAL 相当。
 * 例: `const item = unnest(schema.setlists.items);`
 */
export function unnest<M extends ColMeta, TRow>(
  column: ColumnRef<M, TRow>,
): UnnestSource<ElementOf<NonNullable<M["data"]>>, TRow> {
  if (column.def.kind !== "array") {
    throw new JsonRdbError(
      `unnest() は配列カラムにのみ使えます（${column.table._.name}.${column.key} は ${column.def.kind}）`,
    );
  }
  const elementToken = {};
  const indexToken = {};
  const meta: UnnestMeta = {
    parentTable: column.table,
    arrayKey: column.key,
    elementToken,
    indexToken,
  };
  const source: Record<string, unknown> & { [UNNEST]: UnnestMeta } = {
    [UNNEST]: meta,
    $parent: column.table,
    $: makeFieldRefs(column.def.element, elementToken, []),
    $index: makeFieldRefs(undefined, indexToken, []),
  };
  const elementDef = column.def.element;
  if (elementDef?.kind === "object" && elementDef.shape) {
    for (const [key, child] of Object.entries(elementDef.shape)) {
      source[key] = makeFieldRefs(child, elementToken, [key]);
    }
  }
  return source as never;
}

// ---------------------------------------------------------------------------
// select ビルダー
// ---------------------------------------------------------------------------

/** SelectBuilder がデータ供給元（Db）に要求する最小インターフェース */
export interface QuerySources {
  rowsOf(table: AnyTable): readonly unknown[];
  defaultOrderOf(table: AnyTable): readonly OrderSpec[] | undefined;
}

interface JoinClause {
  readonly table: AnyTable;
  readonly on: Expr<boolean>;
  readonly kind: "inner" | "left";
}

type KeyedOf<T extends AnyTable> = { [K in TableName<T>]: InferRow<T> };
type ElementTypeOf<U extends AnyUnnestSource> = NonNullable<U["~element"]>;

export class SelectEntry<P extends Projection | undefined> {
  private readonly sources: QuerySources;
  private readonly projection: P;

  constructor(sources: QuerySources, projection: P) {
    this.sources = sources;
    this.projection = projection;
  }

  from<T extends AnyTable>(table: T): SelectBuilder<SelectedRow<P, InferRow<T>>, P, KeyedOf<T>>;
  from<U extends AnyUnnestSource>(
    source: U,
  ): SelectBuilder<SelectedRow<P, ElementTypeOf<U>>, P, never>;
  from(source: AnyTable | AnyUnnestSource): any {
    return new SelectBuilder(this.sources, this.projection, source);
  }
}

/**
 * TRow: 現在の結果行型。P: 射影。TKeyed: 射影なしで join したときの
 * テーブル名キー結果のベース（from が unnest のときは never = 射影必須）。
 */
export class SelectBuilder<TRow, P extends Projection | undefined, TKeyed = never> {
  private readonly sources: QuerySources;
  private readonly projection: P;
  private readonly fromSource: AnyTable | AnyUnnestSource;
  private readonly joins: JoinClause[] = [];
  private readonly wheres: Expr<boolean>[] = [];
  private orders: readonly OrderSpec[] = [];
  private limitCount: number | null = null;
  private distinctKeyFn: ((row: TRow) => unknown) | null = null;

  constructor(sources: QuerySources, projection: P, fromSource: AnyTable | AnyUnnestSource) {
    this.sources = sources;
    this.projection = projection;
    this.fromSource = fromSource;
  }

  innerJoin<T extends AnyTable>(
    table: T,
    on: Expr<boolean>,
  ): SelectBuilder<
    P extends Projection ? TRow : Simplify<TKeyed & KeyedOf<T>>,
    P,
    Simplify<TKeyed & KeyedOf<T>>
  > {
    this.joins.push({ table, on, kind: "inner" });
    return this as never;
  }

  leftJoin<T extends AnyTable>(
    table: T,
    on: Expr<boolean>,
  ): SelectBuilder<
    P extends Projection
      ? NullifyProjected<TRow, P, T>
      : Simplify<TKeyed & { [K in TableName<T>]: InferRow<T> | null }>,
    P,
    Simplify<TKeyed & { [K in TableName<T>]: InferRow<T> | null }>
  > {
    this.joins.push({ table, on, kind: "left" });
    return this as never;
  }

  /** 複数回呼ぶと AND 結合 */
  where(condition: Expr<boolean>): this {
    this.wheres.push(condition);
    return this;
  }

  /** asc()/desc() の OrderSpec か、式を直接（暗黙 asc）指定できる */
  orderBy(...specs: readonly (OrderSpec | Expr<any>)[]): this {
    this.orders = specs.map((spec): OrderSpec => (isExpr(spec) ? asc(spec) : (spec as OrderSpec)));
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  /** 射影後の行からキーを取り、最初に現れた行だけを残す */
  distinctBy(key: (row: TRow) => unknown): this {
    this.distinctKeyFn = key;
    return this;
  }

  all(): TRow[] {
    let contexts = this.buildContexts();
    for (const join of this.joins) {
      contexts = this.applyJoin(contexts, join);
    }
    for (const where of this.wheres) {
      contexts = contexts.filter((bindings) => evaluate(where, bindings) === true);
    }

    // 明示 orderBy が無ければ from テーブルの defaultOrder を適用する
    const orders = this.orders.length > 0 ? this.orders : this.defaultOrders();
    if (orders.length > 0) {
      contexts = [...contexts].sort((a, b) => {
        for (const spec of orders) {
          const result = compareBySpec(evaluate(spec.expr, a), evaluate(spec.expr, b), spec);
          if (result !== 0) return result;
        }
        return 0;
      });
    }

    let rows = contexts.map((bindings) => this.projectRow(bindings)) as TRow[];
    const distinctKey = this.distinctKeyFn;
    if (distinctKey !== null) {
      const seen = new Set<unknown>();
      rows = rows.filter((row) => {
        const key = distinctKey(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    return rows;
  }

  first(): TRow | undefined {
    return this.all()[0];
  }

  firstOrThrow(): TRow {
    const row = this.first();
    if (row === undefined) {
      throw new JsonRdbError("クエリ結果が 0 件でした");
    }
    return row;
  }

  count(): number {
    return this.all().length;
  }

  countBy<K>(key: (row: TRow) => K): Map<K, number> {
    const counts = new Map<K, number>();
    for (const row of this.all()) {
      const k = key(row);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }

  private defaultOrders(): readonly OrderSpec[] {
    if (isUnnestSource(this.fromSource)) return [];
    return this.sources.defaultOrderOf(this.fromSource) ?? [];
  }

  private buildContexts(): readonly Bindings[] {
    if (isUnnestSource(this.fromSource)) {
      const meta = this.fromSource[UNNEST];
      const contexts: Bindings[] = [];
      for (const row of this.sources.rowsOf(meta.parentTable)) {
        const array = (row as Record<string, unknown>)[meta.arrayKey];
        if (!Array.isArray(array)) continue;
        array.forEach((element, index) => {
          contexts.push(
            new Map<object, unknown>([
              [meta.parentTable, row],
              [meta.elementToken, element],
              [meta.indexToken, index],
            ]),
          );
        });
      }
      return contexts;
    }
    return this.sources
      .rowsOf(this.fromSource)
      .map((row) => new Map<object, unknown>([[this.fromSource as object, row]]));
  }

  private applyJoin(contexts: readonly Bindings[], join: JoinClause): Bindings[] {
    const rows = this.sources.rowsOf(join.table);
    const lookup = this.hashLookupFor(join, rows);
    const next: Bindings[] = [];
    for (const context of contexts) {
      const matches =
        lookup !== null
          ? lookup(context)
          : rows.filter((row) => {
              const candidate = new Map(context);
              candidate.set(join.table, row);
              return evaluate(join.on, candidate) === true;
            });
      if (matches.length === 0) {
        if (join.kind === "left") {
          const missed = new Map(context);
          missed.set(join.table, null);
          next.push(missed);
        }
        continue;
      }
      for (const row of matches) {
        const matched = new Map(context);
        matched.set(join.table, row);
        next.push(matched);
      }
    }
    return next;
  }

  /**
   * on が「join 先テーブルのカラム = 外側の式」の形ならハッシュ結合にする。
   * それ以外はネストループへフォールバック。
   */
  private hashLookupFor(
    join: JoinClause,
    rows: readonly unknown[],
  ): ((context: Bindings) => readonly unknown[]) | null {
    const node = join.on[EXPR];
    if (node.kind !== "binary" || node.op !== "eq") return null;
    const sides: readonly [Expr, Expr][] = [
      [node.left, node.right],
      [node.right, node.left],
    ];
    for (const [joinSide, outerSide] of sides) {
      const sideNode = joinSide[EXPR];
      if (
        sideNode.kind === "column" &&
        sideNode.table === join.table &&
        !exprReferencesSource(outerSide, join.table)
      ) {
        const index = new Map<unknown, unknown[]>();
        for (const row of rows) {
          const value = (row as Record<string, unknown>)[sideNode.key];
          if (value === null || value === undefined) continue;
          const bucket = index.get(value);
          if (bucket === undefined) {
            index.set(value, [row]);
          } else {
            bucket.push(row);
          }
        }
        return (context) => {
          const key = evaluate(outerSide, context);
          if (key === null || key === undefined) return [];
          return index.get(key) ?? [];
        };
      }
    }
    return null;
  }

  private projectRow(bindings: Bindings): unknown {
    if (this.projection !== undefined) {
      const out: Record<string, unknown> = {};
      for (const [key, selector] of Object.entries(this.projection)) {
        if (isTable(selector)) {
          if (!bindings.has(selector)) {
            throw new JsonRdbError(
              `射影のテーブル "${selector._.name}" はこのクエリのソースに含まれていません`,
            );
          }
          out[key] = bindings.get(selector) ?? null;
        } else {
          out[key] = evaluate(selector, bindings);
        }
      }
      return out;
    }
    if (this.joins.length === 0) {
      if (isUnnestSource(this.fromSource)) {
        return bindings.get(this.fromSource[UNNEST].elementToken);
      }
      return bindings.get(this.fromSource);
    }
    // 射影なし + join: テーブル名キーの結果を組み立てる
    if (isUnnestSource(this.fromSource)) {
      throw new JsonRdbError(
        "unnest をソースにした join では射影（select({...})）を指定してください",
      );
    }
    const out: Record<string, unknown> = {
      [this.fromSource._.name]: bindings.get(this.fromSource),
    };
    for (const join of this.joins) {
      out[join.table._.name] = bindings.get(join.table) ?? null;
    }
    return out;
  }
}

/** 式が指定ソース（テーブル）のカラムを参照しているか（ハッシュ結合の判定用） */
function exprReferencesSource(expr: Expr, table: object): boolean {
  const node = expr[EXPR];
  switch (node.kind) {
    case "column":
      return node.table === table;
    case "field":
    case "literal":
      return false;
    case "binary":
      return exprReferencesSource(node.left, table) || exprReferencesSource(node.right, table);
    case "inArray":
    case "nullCheck":
      return exprReferencesSource(node.expr, table);
    case "logical":
      return node.operands.some((operand) => exprReferencesSource(operand, table));
    case "not":
      return exprReferencesSource(node.operand, table);
    case "some":
      return exprReferencesSource(node.array, table) || exprReferencesSource(node.predicate, table);
    case "arrayContains":
      return exprReferencesSource(node.array, table) || exprReferencesSource(node.value, table);
  }
}
