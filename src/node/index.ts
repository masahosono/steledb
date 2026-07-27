/**
 * Node.js-only helpers: loading JSON from the filesystem, and a validation
 * runner for CI. This entry point is kept separate from the core (which does not
 * depend on fs); import it from `steledb/node`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SteleDbError, formatErrors } from "../errors.js";
import type { Schema, SchemaTables, TablesData } from "../schema.js";
import { type ValidateOptions, type ValidationResult, validate } from "../validate.js";

export interface LoadTablesOptions {
  /**
   * Maps a table key to a file name. Defaults to `<table key>.json`.
   * Use it for kebab-case file names such as digital-singles.json.
   */
  readonly fileFor?: (tableKey: string) => string;
}

function toDirPath(dir: string | URL): string {
  return typeof dir === "string" ? dir : fileURLToPath(dir);
}

/**
 * Loads the JSON files in a directory for every table in the schema.
 * A missing file, a JSON parse failure, or a non-array at the top level throws
 * with a specific message.
 */
export async function loadTablesFromDir<S extends SchemaTables>(
  dir: string | URL,
  schema: Schema<S>,
  options: LoadTablesOptions = {},
): Promise<TablesData<S>> {
  const fileFor = options.fileFor ?? ((tableKey: string) => `${tableKey}.json`);
  const dirPath = toDirPath(dir);
  const data: Record<string, readonly unknown[]> = {};
  for (const tableKey of schema._.tables.keys()) {
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
    data[tableKey] = parsed;
  }
  return data as TablesData<S>;
}

export interface IntegrityCheckOptions<S extends SchemaTables> {
  readonly schema: Schema<S>;
  /** Set this to load from a JSON directory (mutually exclusive with data) */
  readonly dataDir?: string | URL;
  /** Set this to pass already loaded data (mutually exclusive with dataDir) */
  readonly data?: TablesData<S>;
  readonly fileFor?: (tableKey: string) => string;
  readonly validateOptions?: ValidateOptions;
  /** Where success output goes (defaults to console.log) */
  readonly log?: (line: string) => void;
  /** Where error output goes (defaults to console.error) */
  readonly error?: (line: string) => void;
}

/**
 * The CI runner for a data integrity check. It lists every error and sets
 * `process.exitCode = 1`; on success it prints a per-table row count summary.
 * A consuming project only has to call this from its check script:
 *
 * ```ts
 * // scripts/check-data.ts
 * import { runIntegrityCheck } from "steledb/node";
 * import { schema } from "../src/db/schema.ts";
 * await runIntegrityCheck({ schema, dataDir: new URL("../src/data/", import.meta.url) });
 * ```
 */
export async function runIntegrityCheck<S extends SchemaTables>(
  options: IntegrityCheckOptions<S>,
): Promise<ValidationResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

  let data: TablesData<S>;
  if (options.data !== undefined) {
    data = options.data;
  } else if (options.dataDir !== undefined) {
    data = await loadTablesFromDir(
      options.dataDir,
      options.schema,
      options.fileFor === undefined ? {} : { fileFor: options.fileFor },
    );
  } else {
    throw new SteleDbError("runIntegrityCheck requires either data or dataDir");
  }

  const result = validate(options.schema, data, options.validateOptions);
  if (result.ok) {
    const dataRecord = data as Readonly<Record<string, readonly unknown[]>>;
    const summary = [...options.schema._.tables.keys()]
      .map((tableKey) => `${tableKey}: ${dataRecord[tableKey]?.length ?? 0}`)
      .join(" / ");
    log("✅ data integrity OK");
    log(`  ${summary}`);
  } else {
    error(formatErrors(result.errors));
    process.exitCode = 1;
  }
  return result;
}
