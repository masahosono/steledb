import { SteleDbError } from "./errors.js";

/**
 * Type-level metadata for a column. Rather than separate type parameters it is
 * collapsed into a single object type (the config-object style). `data` is the
 * final TS value type, and nullable is folded into it as `| null`. `optional`
 * means "the key may be absent from the JSON" and is kept apart from `data`
 * because it only drives the `?:` in the derived row type.
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
 * A partial update of ColMeta. A closed-key mapped type plus the
 * `infer R extends ColMeta` re-constraint is what proves to TS that the result
 * still satisfies ColMeta (a naive Omit & intersection fails in generic positions).
 */
export type MergeMeta<M extends ColMeta, P extends Partial<ColMeta>> = {
  [K in keyof ColMeta]: K extends keyof P ? Exclude<P[K], undefined> : M[K];
} extends infer R extends ColMeta
  ? R
  : never;

export type ColumnKind = "string" | "number" | "boolean" | "enum" | "array" | "object";

/**
 * A structural type for accepting a bound column reference (table.ts's ColumnRef)
 * without a circular import from column.ts. Used as the return type of the
 * references / mustMatch thunks.
 */
export interface RefColumnLike<TData> {
  readonly _: ColMeta & { data: TData };
}

export type ReferenceSpec =
  | { readonly form: "thunk"; readonly get: () => RefColumnLike<unknown> }
  | { readonly form: "named"; readonly table: string; readonly column: string };

export interface MustMatchSpec {
  /** Thunk pointing at the master column the value has to match */
  readonly target: () => RefColumnLike<unknown>;
  /** Name of the FK field in the same object scope (used to locate the master row) */
  readonly via: string;
  /** When set: a mismatch with target is tolerated if this array column contains the value */
  readonly orIn?: () => RefColumnLike<unknown>;
}

/**
 * The runtime definition of a column. The builder (Column) is immutable: every
 * modifier returns a new instance carrying a new def.
 */
export interface ColumnDef {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly enumValues?: readonly string[];
  /** Element definition, for kind === "array" */
  readonly element?: ColumnDef;
  /** Field definitions, for kind === "object" */
  readonly shape?: Readonly<Record<string, ColumnDef>>;
  readonly reference?: ReferenceSpec;
  readonly mustMatch?: MustMatchSpec;
  /** Arrays only. Extracts the composite unique key scoped to the parent record */
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

  /** Allows null as a value (the row type becomes `T | null`). */
  nullable(): Column<MergeMeta<M, { data: M["data"] | null }>> {
    return this.with({ nullable: true });
  }

  /** The key may be absent from the JSON (the row type becomes `key?: T`). */
  optional(): Column<MergeMeta<M, { optional: true }>> {
    return this.with({ optional: true });
  }

  /** Primary key. Implies unique. One column per table (defineSchema enforces it). */
  primaryKey(): Column<MergeMeta<M, { primaryKey: true; unique: true }>> {
    return this.with({ primaryKey: true, unique: true });
  }

  /** Forbids duplicate values across the table (multiple nulls are fine). */
  unique(): Column<MergeMeta<M, { unique: true }>> {
    return this.with({ unique: true });
  }

  /**
   * Declares a foreign key. The thunk form `references(() => other.id)` is the
   * primary one; the string form `references("other", "id")` is a fallback for
   * cases such as circular references where the types cannot be built
   * (defineSchema resolves and validates it).
   */
  references(target: () => RefColumnLike<NonNullable<M["data"]>>): this;
  references(table: string, column: string): this;
  references(target: (() => RefColumnLike<unknown>) | string, column?: string): this {
    if (typeof target === "string") {
      if (column === undefined) {
        throw new SteleDbError(
          `references("${target}") also requires a column name (e.g. references("${target}", "id"))`,
        );
      }
      return this.with({ reference: { form: "named", table: target, column } });
    }
    return this.with({ reference: { form: "thunk", get: target } });
  }

  /**
   * Checks a denormalized field against its source. The master row is located
   * through the FK field (via) in the same object scope, and this field's value
   * is compared with the target column. Passing orIn switches to alias-tolerant
   * mode: "equal to target, or contained in orIn". Leaving it undeclared means
   * no check at all (spelling variations are allowed).
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
   * Arrays only. A composite unique constraint scoped to the parent record: the
   * return value of the key function must not repeat within the same array
   * (e.g. `(tr) => [tr.disc ?? 1, tr.no]`).
   */
  uniqueBy(key: (element: ElementOf<M["data"]>) => unknown): this {
    if (this.def.kind !== "array") {
      throw new SteleDbError("uniqueBy() can only be applied to array columns (t.array)");
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
 * Derives the row object type from a Shape (a Record of column builders).
 * Optional keys become `?:`, because optional only ever means "key missing"
 * (JSON has no undefined).
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

  /** An enum of string literals. The value type is inferred as a literal union. */
  enum<const V extends readonly [string, ...string[]]>(
    ...values: V
  ): Column<DefaultMeta<V[number]>> {
    return new Column({ kind: "enum", enumValues: values, ...baseFlags });
  },

  array<C extends AnyColumn>(element: C): Column<DefaultMeta<ColumnData<C>[]>> {
    return new Column({ kind: "array", element: element.def, ...baseFlags });
  },

  /** A nested object. The type is settled here, expanding InferShape one level at a time. */
  object<S extends Shape>(shape: S): Column<DefaultMeta<InferShape<S>>> {
    const defs: Record<string, ColumnDef> = {};
    for (const [key, column] of Object.entries(shape)) {
      defs[key] = column.def;
    }
    return new Column({ kind: "object", shape: defs, ...baseFlags });
  },
};
