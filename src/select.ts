import type { Simplify } from "./column.js";
import { JsonRdbError } from "./errors.js";
import {
  type Bindings,
  type Expr,
  type OrderSpec,
  asc,
  compareBySpec,
  evaluate,
  isExpr,
} from "./expr.js";
import { type AnyTable, type InferRow, isTable } from "./table.js";

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

/** SelectBuilder がデータ供給元（Db）に要求する最小インターフェース */
export interface QuerySources {
  rowsOf(table: AnyTable): readonly unknown[];
  defaultOrderOf(table: AnyTable): readonly OrderSpec[] | undefined;
}

export class SelectEntry<P extends Projection | undefined> {
  private readonly sources: QuerySources;
  private readonly projection: P;

  constructor(sources: QuerySources, projection: P) {
    this.sources = sources;
    this.projection = projection;
  }

  from<T extends AnyTable>(table: T): SelectBuilder<SelectedRow<P, InferRow<T>>, P> {
    return new SelectBuilder(this.sources, this.projection, table);
  }
}

export class SelectBuilder<TRow, P extends Projection | undefined> {
  private readonly sources: QuerySources;
  private readonly projection: P;
  private readonly fromTable: AnyTable;
  private readonly wheres: Expr<boolean>[] = [];
  private orders: readonly OrderSpec[] = [];
  private limitCount: number | null = null;
  private distinctKeyFn: ((row: TRow) => unknown) | null = null;

  constructor(sources: QuerySources, projection: P, fromTable: AnyTable) {
    this.sources = sources;
    this.projection = projection;
    this.fromTable = fromTable;
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
    for (const where of this.wheres) {
      contexts = contexts.filter((bindings) => evaluate(where, bindings) === true);
    }

    // 明示 orderBy が無ければ from テーブルの defaultOrder を適用する
    const orders =
      this.orders.length > 0 ? this.orders : (this.sources.defaultOrderOf(this.fromTable) ?? []);
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

  private buildContexts(): readonly Bindings[] {
    return this.sources
      .rowsOf(this.fromTable)
      .map((row) => new Map<object, unknown>([[this.fromTable, row]]));
  }

  private projectRow(bindings: Bindings): unknown {
    if (this.projection === undefined) {
      return bindings.get(this.fromTable);
    }
    const out: Record<string, unknown> = {};
    for (const [key, selector] of Object.entries(this.projection)) {
      if (isTable(selector)) {
        if (!bindings.has(selector)) {
          throw new JsonRdbError(
            `射影のテーブル "${selector._.name}" はこのクエリのソースに含まれていません`,
          );
        }
        out[key] = bindings.get(selector);
      } else {
        out[key] = evaluate(selector, bindings);
      }
    }
    return out;
  }
}
