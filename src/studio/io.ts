/**
 * Reading and writing the JSON files behind a studio session.
 *
 * The guiding rule is that a file the studio saves without an edit must come
 * back byte for byte identical: the original indentation and trailing newline
 * are detected on read and reproduced on write, and key order survives because
 * JSON.parse / JSON.stringify both preserve insertion order. That keeps studio
 * edits reviewable as small diffs in version control.
 */
import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SteleDbError } from "../errors.js";

/** Raised when a file changed underneath the studio since it was last read. */
export class StudioConflictError extends SteleDbError {
  override name = "StudioConflictError";
}

export interface JsonFormat {
  /** Spaces per level, or "\t" for tab-indented files */
  readonly indent: number | string;
  readonly trailingNewline: boolean;
}

export interface TableFile {
  readonly tableKey: string;
  readonly path: string;
  readonly rows: readonly unknown[];
  /** The exact text that was read, used to reuse untouched rows verbatim on write */
  readonly text: string;
  /** Content hash of what was read, used for optimistic locking on write */
  readonly revision: string;
  readonly format: JsonFormat;
}

/** The original file, as the input for preserving the formatting of untouched rows. */
export interface OriginalText {
  readonly text: string;
  readonly rows: readonly unknown[];
}

export const DEFAULT_FORMAT: JsonFormat = { indent: 2, trailingNewline: true };

export function toDirPath(dir: string | URL): string {
  return typeof dir === "string" ? dir : fileURLToPath(dir);
}

export function defaultFileFor(tableKey: string): string {
  return `${tableKey}.json`;
}

/** A short content hash. Not security relevant — it only detects "this changed". */
export function revisionOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * Infers the indentation from the first indented line, which for a top-level
 * array is the opening of its first element and therefore exactly one level.
 */
export function detectFormat(text: string): JsonFormat {
  let indent: number | string = DEFAULT_FORMAT.indent;
  for (const line of text.split("\n")) {
    const match = /^([ \t]+)\S/.exec(line);
    if (match === null) continue;
    const whitespace = match[1] as string;
    indent = whitespace.startsWith("\t") ? "\t" : whitespace.length;
    break;
  }
  return { indent, trailingNewline: text.endsWith("\n") };
}

/**
 * Serializes rows back to JSON text.
 *
 * When the original text is supplied, rows whose content is unchanged are
 * written back as the exact source text they came from, and only new or edited
 * rows are re-stringified. That matters because JSON.stringify has one single
 * idea of how to lay out a value: a hand-formatted file that keeps, say,
 * `"tracks": [{ "no": 1 }, { "no": 2 }]` on one line would otherwise explode
 * across ten lines the first time any unrelated cell in the file is saved.
 * Falls back to a plain stringify whenever the text cannot be reused safely.
 */
export function serializeRows(
  rows: readonly unknown[],
  format: JsonFormat,
  original?: OriginalText,
): string {
  if (original !== undefined) {
    const preserved = serializePreserving(rows, format, original);
    if (preserved !== null) return preserved;
  }
  const body = JSON.stringify(rows, null, format.indent);
  return format.trailingNewline ? `${body}\n` : body;
}

interface ArrayLayout {
  /** Everything before the first element, e.g. "[\n  " */
  readonly prefix: string;
  /** The source text of each top-level element, trimmed of surrounding whitespace */
  readonly elements: readonly string[];
  /** The text between consecutive elements, e.g. ",\n  " */
  readonly separators: readonly string[];
  /** Everything from the end of the last element, e.g. "\n]\n" */
  readonly suffix: string;
  /** The indentation the elements sit at */
  readonly pad: string;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function trimEndIndex(text: string, from: number, limit: number): number {
  let end = limit;
  while (end > from && isSpace(text[end - 1] as string)) end--;
  return end;
}

/**
 * Splits a JSON array's source text into its top-level elements and the
 * whitespace around them. Strings (and the escapes inside them) are tracked so
 * that a bracket or comma inside a value never ends an element early.
 */
export function scanArrayLayout(text: string): ArrayLayout | null {
  const open = text.indexOf("[");
  if (open === -1 || text.slice(0, open).trim() !== "") return null;

  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let close = -1;

  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0 && start === -1) start = i;
      inString = true;
      continue;
    }
    if (ch === "[" || ch === "{") {
      if (depth === 0 && start === -1) start = i;
      depth++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (depth === 0) {
        close = i;
        break;
      }
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (start === -1) return null;
      spans.push({ start, end: trimEndIndex(text, start, i) });
      start = -1;
      continue;
    }
    if (depth === 0 && start === -1 && !isSpace(ch)) start = i;
  }

  if (close === -1) return null;
  if (start !== -1) spans.push({ start, end: trimEndIndex(text, start, close) });
  if (spans.length === 0) return null;

  const first = spans[0] as { start: number; end: number };
  const last = spans[spans.length - 1] as { start: number; end: number };
  const prefix = text.slice(0, first.start);
  const lastLine = prefix.slice(prefix.lastIndexOf("\n") + 1);

  return {
    prefix,
    elements: spans.map((span) => text.slice(span.start, span.end)),
    separators: spans
      .slice(0, -1)
      .map((span, index) => text.slice(span.end, (spans[index + 1] as { start: number }).start)),
    suffix: text.slice(last.end),
    pad: /^[ \t]*$/.test(lastLine) ? lastLine : "",
  };
}

function indentBlock(text: string, pad: string): string {
  if (pad === "") return text;
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : pad + line))
    .join("\n");
}

function serializePreserving(
  rows: readonly unknown[],
  format: JsonFormat,
  original: OriginalText,
): string | null {
  if (rows.length === 0) return null;
  const layout = scanArrayLayout(original.text);
  if (layout === null || layout.elements.length !== original.rows.length) return null;

  // Match by content rather than by position, so inserting or deleting a row
  // does not force every row after it to be re-stringified.
  const pool = new Map<string, string[]>();
  original.rows.forEach((row, index) => {
    const key = JSON.stringify(row) ?? "";
    const list = pool.get(key);
    const source = layout.elements[index] as string;
    if (list === undefined) pool.set(key, [source]);
    else list.push(source);
  });

  const defaultSeparator =
    layout.separators[layout.separators.length - 1] ??
    (layout.pad === "" ? ", " : `,\n${layout.pad}`);

  const pieces = rows.map((row) => {
    const key = JSON.stringify(row) ?? "";
    const reusable = pool.get(key);
    const source = reusable?.shift();
    if (source !== undefined) return source;
    return indentBlock(JSON.stringify(row, null, format.indent), layout.pad);
  });

  let out = layout.prefix;
  pieces.forEach((piece, index) => {
    if (index > 0) out += layout.separators[index - 1] ?? defaultSeparator;
    out += piece;
  });
  out += layout.suffix;

  // Never hand back text that does not parse to exactly the rows requested.
  try {
    if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(rows)) return null;
  } catch {
    return null;
  }
  return out;
}

export async function readTableFile(
  dirPath: string,
  tableKey: string,
  fileFor: (tableKey: string) => string = defaultFileFor,
): Promise<TableFile> {
  const path = join(dirPath, fileFor(tableKey));
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (cause) {
    throw new SteleDbError(`cannot read the file for table "${tableKey}": ${path}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SteleDbError(`failed to parse the JSON in ${path}: ${String(cause)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new SteleDbError(`the top level of ${path} is not an array`);
  }
  return {
    tableKey,
    path,
    rows: parsed as readonly unknown[],
    text,
    revision: revisionOf(text),
    format: detectFormat(text),
  };
}

export interface WriteTableFileOptions {
  readonly path: string;
  readonly rows: readonly unknown[];
  readonly format: JsonFormat;
  /**
   * The revision the caller based its edit on. When it no longer matches what
   * is on disk the write is refused, so an edit made outside the studio is
   * never silently overwritten. Pass undefined to skip the check.
   */
  readonly expectedRevision?: string;
  /** The file as it was read, so untouched rows keep their original formatting */
  readonly original?: OriginalText;
}

export interface WriteResult {
  readonly revision: string;
  readonly text: string;
}

/**
 * Writes rows back atomically: a sibling temp file followed by a rename, so a
 * crash mid-write cannot leave a half-written data file behind.
 */
export async function writeTableFile(options: WriteTableFileOptions): Promise<WriteResult> {
  const { path, rows, format, expectedRevision, original } = options;

  if (expectedRevision !== undefined) {
    let current: string | undefined;
    try {
      current = await readFile(path, "utf-8");
    } catch {
      current = undefined;
    }
    if (current !== undefined && revisionOf(current) !== expectedRevision) {
      throw new StudioConflictError(
        `${path} changed outside the studio since it was loaded — reload before saving`,
      );
    }
  }

  const text = serializeRows(rows, format, original);
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, text, "utf-8");
    await rename(tmpPath, path);
  } catch (cause) {
    await unlink(tmpPath).catch(() => {});
    throw new SteleDbError(`failed to write ${path}`, { cause });
  }
  return { revision: revisionOf(text), text };
}
