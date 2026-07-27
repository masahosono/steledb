/** An error for problems other than data: schema definition mistakes, API misuse, and so on. */
export class JsonRdbError extends Error {
  override name = "JsonRdbError";
}

/**
 * Fields shared by every data validation error. They describe "which field of
 * which row of which table is broken, and how" as structured data, so the raw
 * JSON can be fed straight into an AI editing workflow as a fix instruction.
 */
export interface ValidationErrorBase {
  /** Schema key */
  readonly table: string;
  readonly rowIndex: number;
  /** Primary key value, when one could be read */
  readonly rowKey: string | number | null;
  /** Row label produced by displayAs (falls back to the PK or the row index) */
  readonly rowLabel: string;
  /** Exact location inside the row (arrays use numeric indexes). Empty for row-level errors */
  readonly path: readonly (string | number)[];
  /** Display form of path (e.g. "coveredEvents[0].tracks[3].songId") */
  readonly pathString: string;
  /** Formatted message (without location info, which formatErrors adds) */
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
        readonly code: "DUPLICATE_COMPOSITE_KEY";
        /** Column keys forming the key, in declaration order */
        readonly columns: readonly string[];
        /** Their values in this row, in the same order */
        readonly values: readonly unknown[];
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

/** Renders a (string | number)[] path as "items[2].songId". */
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
 * Renders validation errors as a human readable multi-line string for CLI / CI.
 * Each error takes two lines: the row it belongs to plus the message, then the location.
 */
export function formatErrors(errors: readonly ValidationError[]): string {
  const lines: string[] = [`❌ ${errors.length} integrity error(s):`];
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
