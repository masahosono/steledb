import type { ColumnDef } from "./column.js";
import { JsonRdbError } from "./errors.js";
import { type AnyTable, ColumnRef } from "./table.js";

export type SchemaTables = Record<string, AnyTable>;

/**
 * defineSchema() の戻り値。テーブルへ `schema.songs` のように直接アクセスできる。
 * `_` はメタデータ用に予約（スキーマキーに使えない）。
 */
export type Schema<S extends SchemaTables> = { readonly [K in keyof S]: S[K] } & SchemaBrand;

export interface SchemaBrand {
  readonly _: SchemaMeta;
}

export type AnySchema = SchemaBrand;

/** スキーマに注入するデータ。キーはスキーマキーと 1:1（過不足はコンパイルエラー） */
export type TablesData<S extends SchemaTables> = { readonly [K in keyof S]: readonly unknown[] };

export interface SchemaMeta {
  /** スキーマキー → テーブル */
  readonly tables: ReadonlyMap<string, AnyTable>;
  /** テーブル実体 → スキーマキー（ColumnRef からの逆引きに使う） */
  readonly keyByTable: ReadonlyMap<AnyTable, string>;
  /** スキーマキー → 解決済み制約 */
  readonly constraints: ReadonlyMap<string, TableConstraints>;
}

export interface ResolvedColumn {
  readonly tableKey: string;
  readonly columnKey: string;
}

/**
 * パスは shape 内の位置を表すセグメント列。文字列キーと、配列要素を表す
 * マーカー "[]" からなる（例: ["coveredEvents", "[]", "tracks", "[]", "songId"]）。
 */
export type Path = readonly string[];

export interface ReferenceConstraint {
  readonly path: Path;
  readonly target: ResolvedColumn;
}

export interface MustMatchConstraint {
  /** 非正規化フィールド自身のパス */
  readonly path: Path;
  /** 同一スコープ内の FK フィールド名 */
  readonly via: string;
  /** via の参照先（マスタ行の lookup キー） */
  readonly viaTarget: ResolvedColumn;
  /** 一致すべきマスタ側カラム */
  readonly target: ResolvedColumn;
  /** alias 許容モードで追加確認するマスタ側配列カラム */
  readonly orIn?: ResolvedColumn;
}

export interface UniqueByConstraint {
  /** 対象の配列カラムのパス */
  readonly path: Path;
  readonly key: (element: never) => unknown;
}

export interface TableConstraints {
  readonly pk: string | null;
  /** unique 宣言された top-level カラムキー（PK を含む） */
  readonly uniques: readonly string[];
  readonly references: readonly ReferenceConstraint[];
  readonly mustMatches: readonly MustMatchConstraint[];
  readonly uniqueBys: readonly UniqueByConstraint[];
}

/** パスを "coveredEvents[].tracks[].songId" 形式の表示用文字列にする */
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
 * スキーマの凍結処理。references / mustMatch の thunk をこの時点で全解決し、
 * 型システムで守れない整合性（via 兄弟の存在、FK 参照先の unique 性、PK の
 * 単一性など）をランタイム検証する。壊れたスキーマは import した瞬間に落ちる。
 */
export function defineSchema<S extends SchemaTables>(tables: S): Schema<S> {
  const tableMap = new Map<string, AnyTable>();
  const keyByTable = new Map<AnyTable, string>();
  const nameToKey = new Map<string, string>();

  for (const [key, tbl] of Object.entries(tables)) {
    if (key === "_" || key.startsWith("~") || key.startsWith("$")) {
      throw new JsonRdbError(
        `スキーマキー "${key}" は使用できません（"_" と "~", "$" 始まりは予約されています）`,
      );
    }
    if (keyByTable.has(tbl)) {
      throw new JsonRdbError(
        `テーブル "${tbl._.name}" がスキーマキー "${keyByTable.get(tbl)}" と "${key}" の両方に登録されています`,
      );
    }
    if (nameToKey.has(tbl._.name)) {
      throw new JsonRdbError(`テーブル名 "${tbl._.name}" が重複しています`);
    }
    tableMap.set(key, tbl);
    keyByTable.set(tbl, key);
    nameToKey.set(tbl._.name, key);
  }

  /** thunk が返した束縛済みカラムを { tableKey, columnKey } に解決する */
  function resolveThunk(get: () => unknown, context: string): ResolvedColumn {
    const ref = get();
    if (!(ref instanceof ColumnRef)) {
      throw new JsonRdbError(`${context}: thunk がカラム参照以外を返しました`);
    }
    const tableKey = keyByTable.get(ref.table);
    if (tableKey === undefined) {
      throw new JsonRdbError(
        `${context}: 参照先テーブル "${ref.table._.name}" がスキーマに登録されていません`,
      );
    }
    return { tableKey, columnKey: ref.key };
  }

  function resolveNamed(tableName: string, columnKey: string, context: string): ResolvedColumn {
    const tableKey = tableMap.has(tableName) ? tableName : nameToKey.get(tableName);
    if (tableKey === undefined) {
      throw new JsonRdbError(
        `${context}: 参照先テーブル "${tableName}" がスキーマに存在しません` +
          `（登録済み: ${[...tableMap.keys()].join(", ")}）`,
      );
    }
    const target = tableMap.get(tableKey);
    if (target === undefined || !(columnKey in target._.shape)) {
      throw new JsonRdbError(`${context}: 参照先カラム "${tableName}.${columnKey}" が存在しません`);
    }
    return { tableKey, columnKey };
  }

  function defAt(resolved: ResolvedColumn): ColumnDef {
    const def = tableMap.get(resolved.tableKey)?._.shape[resolved.columnKey];
    if (def === undefined) {
      throw new JsonRdbError(
        `内部エラー: 解決済みカラム ${resolved.tableKey}.${resolved.columnKey} の定義が見つかりません`,
      );
    }
    return def;
  }

  const constraints = new Map<string, TableConstraints>();

  for (const [key, tbl] of tableMap) {
    const references: ReferenceConstraint[] = [];
    const mustMatches: MustMatchConstraint[] = [];
    const uniqueBys: UniqueByConstraint[] = [];
    let pk: string | null = null;
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
          `${at}: primaryKey / unique はトップレベルカラムにのみ指定できます（ネスト内の重複禁止は uniqueBy を使ってください）`,
        );
      }
      if (isTopLevel) {
        const columnKey = path[0] as string;
        if (def.primaryKey) {
          if (pk !== null) {
            throw new JsonRdbError(
              `テーブル "${tbl._.name}": primaryKey が複数あります ("${pk}" と "${columnKey}")`,
            );
          }
          pk = columnKey;
        }
        if (def.unique) {
          uniques.push(columnKey);
        }
      }

      if (def.reference) {
        const target =
          def.reference.form === "thunk"
            ? resolveThunk(def.reference.get, `${at} の references`)
            : resolveNamed(def.reference.table, def.reference.column, `${at} の references`);
        const targetDef = defAt(target);
        if (!targetDef.unique) {
          throw new JsonRdbError(
            `${at} の references: 参照先 ${target.tableKey}.${target.columnKey} に unique がありません（外部キーの参照先は primaryKey か unique である必要があります）`,
          );
        }
        references.push({ path, target });
      }

      if (def.mustMatch) {
        if (!SCALAR_KINDS.has(def.kind)) {
          throw new JsonRdbError(`${at}: mustMatch はスカラーカラムにのみ指定できます`);
        }
        if (scope === null) {
          throw new JsonRdbError(
            `${at}: mustMatch はオブジェクトスコープ内のフィールドにのみ指定できます（via で兄弟の FK フィールドを参照するため）`,
          );
        }
        const viaDef = scope[def.mustMatch.via];
        if (viaDef === undefined) {
          throw new JsonRdbError(
            `${at} の mustMatch: via "${def.mustMatch.via}" が同一スコープに存在しません` +
              `（存在するフィールド: ${Object.keys(scope).join(", ")}）`,
          );
        }
        if (viaDef.reference === undefined) {
          throw new JsonRdbError(
            `${at} の mustMatch: via "${def.mustMatch.via}" に references がありません`,
          );
        }
        const viaTarget =
          viaDef.reference.form === "thunk"
            ? resolveThunk(viaDef.reference.get, `${at} の mustMatch (via の references)`)
            : resolveNamed(
                viaDef.reference.table,
                viaDef.reference.column,
                `${at} の mustMatch (via の references)`,
              );
        const target = resolveThunk(def.mustMatch.target, `${at} の mustMatch`);
        if (target.tableKey !== viaTarget.tableKey) {
          throw new JsonRdbError(
            `${at} の mustMatch: target (${target.tableKey}.${target.columnKey}) と ` +
              `via の参照先 (${viaTarget.tableKey}.${viaTarget.columnKey}) のテーブルが一致しません`,
          );
        }
        let orIn: ResolvedColumn | undefined;
        if (def.mustMatch.orIn) {
          orIn = resolveThunk(def.mustMatch.orIn, `${at} の mustMatch (orIn)`);
          if (orIn.tableKey !== target.tableKey) {
            throw new JsonRdbError(
              `${at} の mustMatch: orIn (${orIn.tableKey}.${orIn.columnKey}) が target と同じテーブルにありません`,
            );
          }
          if (defAt(orIn).kind !== "array") {
            throw new JsonRdbError(
              `${at} の mustMatch: orIn (${orIn.tableKey}.${orIn.columnKey}) は配列カラムである必要があります`,
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
              `${at}: ネストフィールド名 "${childKey}" は使用できません（"_" と "~", "$" 始まりは予約されています）`,
            );
          }
          visit(childDef, [...path, childKey], def.shape);
        }
      }
    };

    for (const [columnKey, def] of Object.entries(tbl._.shape)) {
      visit(def, [columnKey], tbl._.shape);
    }

    constraints.set(key, { pk, uniques, references, mustMatches, uniqueBys });
  }

  const schema = { ...tables } as Record<string, unknown>;
  const meta: SchemaMeta = { tables: tableMap, keyByTable, constraints };
  Object.defineProperty(schema, "_", { value: meta, enumerable: false });
  return Object.freeze(schema) as Schema<S>;
}

/** スキーマキーからテーブルの解決済み制約を取り出す（存在しないキーは throw） */
export function constraintsOf(schema: AnySchema, tableKey: string): TableConstraints {
  const constraints = schema._.constraints.get(tableKey);
  if (constraints === undefined) {
    throw new JsonRdbError(`テーブルキー "${tableKey}" はスキーマに存在しません`);
  }
  return constraints;
}
