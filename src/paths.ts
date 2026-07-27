/**
 * Walking a schema path over concrete row data. A schema path contains "[]"
 * markers for array elements, so one path can match any number of values in a
 * single row (e.g. "tracks[].songId" matches one value per track). Both
 * validation and the studio's reference graph need this expansion, so it lives
 * here rather than inside validate.ts.
 */
import type { Path } from "./schema.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PathHit {
  readonly value: unknown;
  /** The concrete path, with array indexes filled in */
  readonly path: readonly (string | number)[];
}

/**
 * Walks a schema path (which contains "[]" markers) over concrete row data and
 * collects every matching value together with its concrete path. Missing keys
 * (an absent optional) and broken structure are skipped silently, since this
 * runs on rows whose shape has already been validated.
 */
export function collectAtPath(
  value: unknown,
  segments: Path,
  concrete: readonly (string | number)[],
  out: PathHit[],
): void {
  if (segments.length === 0) {
    out.push({ value, path: concrete });
    return;
  }
  const head = segments[0] as string;
  const rest = segments.slice(1);
  if (head === "[]") {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => {
      collectAtPath(item, rest, [...concrete, index], out);
    });
    return;
  }
  if (!isPlainObject(value) || !(head in value)) return;
  collectAtPath(value[head], rest, [...concrete, head], out);
}

/** collectAtPath as an expression: returns the hits for a path within one row. */
export function hitsAtPath(row: unknown, segments: Path): PathHit[] {
  const out: PathHit[] = [];
  collectAtPath(row, segments, [], out);
  return out;
}
