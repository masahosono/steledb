/** スキーマ定義や API の誤用など、データ以外の問題を表すエラー。 */
export class JsonRdbError extends Error {
  override name = "JsonRdbError";
}

/**
 * データ検証エラーの共通フィールド。「どのテーブルのどの行のどのフィールドが
 * どう壊れているか」を構造化データとして持つ。AI 編集フローでは JSON のまま
 * 修正指示に流せる。
 */
export interface ValidationErrorBase {
  /** スキーマキー */
  readonly table: string;
  readonly rowIndex: number;
  /** PK 値（取得できた場合） */
  readonly rowKey: string | number | null;
  /** displayAs による行の表示（未定義時は PK か行番号にフォールバック） */
  readonly rowLabel: string;
  /** 行内の具体的な位置（配列は数値インデックス）。行自体のエラーは [] */
  readonly path: readonly (string | number)[];
  /** path の表示形（例: "coveredEvents[0].tracks[3].songId"） */
  readonly pathString: string;
  /** 整形済みメッセージ（位置情報は含まない。formatErrors が付与する） */
  readonly message: string;
}

export type ValidationError = ValidationErrorBase &
  (
    | { readonly code: "SHAPE_MISMATCH"; readonly expected: string; readonly actual: unknown }
    | { readonly code: "UNKNOWN_KEY"; readonly key: string }
    | {
        readonly code: "DUPLICATE_KEY";
        readonly column: string;
        readonly value: unknown;
        readonly otherRowIndex: number;
      }
    | {
        readonly code: "FK_VIOLATION";
        readonly value: unknown;
        readonly refTable: string;
        readonly refColumn: string;
      }
    | {
        readonly code: "DENORMALIZED_MISMATCH";
        readonly actual: unknown;
        readonly expected: unknown;
        readonly allowedAliases?: readonly unknown[];
        readonly refTable: string;
        readonly refKeyPath: string;
      }
    | {
        readonly code: "SCOPED_DUPLICATE";
        readonly scopePath: string;
        readonly key: readonly unknown[];
      }
    | { readonly code: "CHECK_FAILED"; readonly detail: string }
  );

export type ValidationErrorCode = ValidationError["code"];

/** (string | number)[] のパスを "items[2].songId" 形式にする */
export function formatErrorPath(path: readonly (string | number)[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out === "" ? seg : `.${seg}`;
    }
  }
  return out;
}

/**
 * 検証エラーを CLI / CI 向けの人間可読な複数行文字列にする。
 * 1 エラー = 「行の特定情報 + メッセージ + 位置」の 2 行。
 */
export function formatErrors(errors: readonly ValidationError[]): string {
  const lines: string[] = [`❌ ${errors.length} 件の整合性エラー:`];
  for (const error of errors) {
    const location =
      error.path.length === 0
        ? `${error.table}[${error.rowIndex}]`
        : `${error.table}[${error.rowIndex}].${error.pathString}`;
    lines.push(`  - ${error.table} ${error.rowLabel}: ${error.message}`);
    lines.push(`      at ${location}`);
  }
  return lines.join("\n");
}
