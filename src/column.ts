import { JsonRdbError } from "./errors.js";

/**
 * カラムの型レベルメタデータ。個別の型パラメータに分けず 1 個のオブジェクト型に
 * 集約する（config-object 方式）。`data` が最終的な TS 値型で、nullable は
 * `data` に `| null` として折り込む。`optional` は「JSON にキー自体が無くてよい」
 * ことを表し、行型の `?:` 導出にのみ使うため `data` とは分離して保持する。
 */
export interface ColMeta {
  data: unknown;
  optional: boolean;
  primaryKey: boolean;
  unique: boolean;
}

export type DefaultMeta<T> = {
  data: T;
  optional: false;
  primaryKey: false;
  unique: false;
};

/**
 * ColMeta の部分更新。closed-key の写像型 + `infer R extends ColMeta` の再制約で
 * 「結果が ColMeta を満たす」ことを TS に保証させる（素朴な Omit & 交差だと
 * ジェネリック文脈で制約エラーになる）。
 */
export type MergeMeta<M extends ColMeta, P extends Partial<ColMeta>> = {
  [K in keyof ColMeta]: K extends keyof P ? Exclude<P[K], undefined> : M[K];
} extends infer R extends ColMeta
  ? R
  : never;

export type ColumnKind = "string" | "number" | "boolean" | "enum" | "array" | "object";

/**
 * 束縛済みカラム参照（table.ts の ColumnRef）を column.ts から循環 import せずに
 * 受けるための構造的型。references / mustMatch の thunk の戻り値に使う。
 */
export interface RefColumnLike<TData> {
  readonly _: ColMeta & { data: TData };
}

export type ReferenceSpec =
  | { readonly form: "thunk"; readonly get: () => RefColumnLike<unknown> }
  | { readonly form: "named"; readonly table: string; readonly column: string };

export interface MustMatchSpec {
  /** 一致すべきマスタ側カラムへの thunk */
  readonly target: () => RefColumnLike<unknown>;
  /** 同一オブジェクトスコープ内にある FK フィールド名（マスタ行の特定に使う） */
  readonly via: string;
  /** 指定時: target と不一致でも、この配列カラムに値が含まれていれば許容する */
  readonly orIn?: () => RefColumnLike<unknown>;
}

/**
 * カラムのランタイム定義。ビルダー（Column）は不変で、修飾のたびに
 * 新しい def を持つインスタンスを返す。
 */
export interface ColumnDef {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly enumValues?: readonly string[];
  /** kind === "array" の要素定義 */
  readonly element?: ColumnDef;
  /** kind === "object" のフィールド定義 */
  readonly shape?: Readonly<Record<string, ColumnDef>>;
  readonly reference?: ReferenceSpec;
  readonly mustMatch?: MustMatchSpec;
  /** kind === "array" 限定。親レコード内スコープの複合 unique キー抽出関数 */
  readonly uniqueBy?: (element: never) => unknown;
}

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

export class Column<M extends ColMeta = ColMeta> {
  declare readonly _: M;
  readonly def: ColumnDef;

  constructor(def: ColumnDef) {
    this.def = def;
  }

  private with(patch: Partial<ColumnDef>): any {
    return new Column({ ...this.def, ...patch });
  }

  /** 値として null を許容する（行型は `T | null` になる） */
  nullable(): Column<MergeMeta<M, { data: M["data"] | null }>> {
    return this.with({ nullable: true });
  }

  /** JSON にキー自体が無くてよい（行型は `key?: T` になる） */
  optional(): Column<MergeMeta<M, { optional: true }>> {
    return this.with({ optional: true });
  }

  /** 主キー。unique を含意する。1 テーブル 1 カラム（defineSchema が検証） */
  primaryKey(): Column<MergeMeta<M, { primaryKey: true; unique: true }>> {
    return this.with({ primaryKey: true, unique: true });
  }

  /** テーブル全体で値の重複を禁止する（null は複数あってもよい） */
  unique(): Column<MergeMeta<M, { unique: true }>> {
    return this.with({ unique: true });
  }

  /**
   * 外部キー宣言。thunk 形式 `references(() => other.id)` を主とし、
   * 循環参照などで型が組めない場合のフォールバックとして
   * 文字列形式 `references("other", "id")` も受ける（defineSchema が解決・検証）。
   */
  references(target: () => RefColumnLike<NonNullable<M["data"]>>): this;
  references(table: string, column: string): this;
  references(target: (() => RefColumnLike<unknown>) | string, column?: string): this {
    if (typeof target === "string") {
      if (column === undefined) {
        throw new JsonRdbError(
          `references("${target}") にはカラム名も指定してください（例: references("${target}", "id")）`,
        );
      }
      return this.with({ reference: { form: "named", table: target, column } });
    }
    return this.with({ reference: { form: "thunk", get: target } });
  }

  /**
   * 非正規化フィールドの一致検証。同一オブジェクトスコープ内の FK フィールド
   * （via）でマスタ行を特定し、このフィールドの値が target カラムと一致するかを
   * 検証する。orIn を指定すると「target と一致、または orIn 配列に含まれる」の
   * alias 許容モードになる。宣言しなければ検証なし（表記ゆれ許容）。
   */
  mustMatch(
    target: () => RefColumnLike<NonNullable<M["data"]>>,
    options: { via: string; orIn?: () => RefColumnLike<readonly NonNullable<M["data"]>[]> },
  ): this {
    const spec: MustMatchSpec =
      options.orIn === undefined
        ? { target, via: options.via }
        : { target, via: options.via, orIn: options.orIn };
    return this.with({ mustMatch: spec });
  }

  /**
   * 配列カラム限定。親レコード内スコープの複合 unique。キー抽出関数の戻り値を
   * キーとして同一配列内の重複を禁止する（例: `(tr) => [tr.disc ?? 1, tr.no]`）。
   */
  uniqueBy(key: (element: ElementOf<M["data"]>) => unknown): this {
    if (this.def.kind !== "array") {
      throw new JsonRdbError("uniqueBy() は配列カラム (t.array) にのみ指定できます");
    }
    return this.with({ uniqueBy: key as (element: never) => unknown });
  }
}

export type AnyColumn = Column<any>;
export type ColumnData<C extends AnyColumn> = C["_"]["data"];

export type Shape = Record<string, AnyColumn>;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K]["_"]["optional"] extends true ? K : never;
}[keyof S];

/**
 * Shape（カラムビルダーの Record）から行のオブジェクト型を導出する。
 * optional なキーは `?:` になる（JSON に undefined は存在しないため、
 * optional は「キー欠落」のみを意味する）。
 */
export type InferShape<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: ColumnData<S[K]> } & {
    [K in OptionalKeys<S>]?: ColumnData<S[K]>;
  }
>;

const baseFlags = {
  nullable: false,
  optional: false,
  primaryKey: false,
  unique: false,
} as const;

export const t = {
  string(): Column<DefaultMeta<string>> {
    return new Column({ kind: "string", ...baseFlags });
  },

  number(): Column<DefaultMeta<number>> {
    return new Column({ kind: "number", ...baseFlags });
  },

  boolean(): Column<DefaultMeta<boolean>> {
    return new Column({ kind: "boolean", ...baseFlags });
  },

  /** 文字列リテラルの enum。値型はリテラルユニオンに推論される */
  enum<const V extends readonly [string, ...string[]]>(
    ...values: V
  ): Column<DefaultMeta<V[number]>> {
    return new Column({ kind: "enum", enumValues: values, ...baseFlags });
  },

  array<C extends AnyColumn>(element: C): Column<DefaultMeta<ColumnData<C>[]>> {
    return new Column({ kind: "array", element: element.def, ...baseFlags });
  },

  /** ネストオブジェクト。型はこの時点で確定する（InferShape を一段で展開） */
  object<S extends Shape>(shape: S): Column<DefaultMeta<InferShape<S>>> {
    const defs: Record<string, ColumnDef> = {};
    for (const [key, column] of Object.entries(shape)) {
      defs[key] = column.def;
    }
    return new Column({ kind: "object", shape: defs, ...baseFlags });
  },
};
