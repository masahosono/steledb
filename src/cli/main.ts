#!/usr/bin/env node
/**
 * The steledb CLI entry point, invoked from a consuming project's package.json
 * as `steledb check --schema ... --data ...`.
 *
 * Two-stage startup: on the first run it re-launches itself as a child process
 * with the `--experimental-strip-types` flag, because without it Node 22 cannot
 * dynamically import a TS file. Node 23.6+ enables it by default, where the flag
 * is harmless. The STELEDB_CLI_BOOTSTRAP environment variable prevents re-entry.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { JsonRdbError } from "../errors.js";
import { runIntegrityCheck } from "../node/index.js";
import type { Schema, SchemaTables } from "../schema.js";

const BOOTSTRAP_ENV = "STELEDB_CLI_BOOTSTRAP";

if (process.env[BOOTSTRAP_ENV] !== "1") {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings=ExperimentalWarning",
      process.argv[1] as string,
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, [BOOTSTRAP_ENV]: "1" },
    },
  );
  if (result.error) {
    console.error(`steledb: failed to spawn the child process: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

interface ParsedArgs {
  readonly subcommand: string | undefined;
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [subcommand, ...rest] = argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) {
      throw new JsonRdbError(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const eq = key.indexOf("=");
    if (eq !== -1) {
      options.set(key.slice(0, eq), key.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    options.set(key, next);
    i++;
  }
  return { subcommand, options, flags };
}

function printHelp(): void {
  console.log(`steledb — schema and data integrity tooling for a static RDB

Usage:
  steledb check --schema <path> --data <dir> [--export <name>] [--json]
  steledb help

Commands:
  check    validate a directory of JSON data against a schema
  help     show this help

Options for 'check':
  --schema <path>   a .ts / .js file exporting the return value of defineSchema()
  --data <dir>      a directory holding one JSON file per table
  --export <name>   the export name of the schema (defaults to "schema")
  --json            print the result as JSON (machine readable, for CI)
`);
}

async function loadSchema(schemaPath: string, exportName: string): Promise<Schema<SchemaTables>> {
  const url = pathToFileURL(schemaPath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (cause) {
    throw new JsonRdbError(`cannot load the schema file: ${schemaPath}`, { cause });
  }
  const value = mod[exportName];
  if (value === undefined) {
    const available = Object.keys(mod)
      .filter((k) => k !== "default")
      .join(", ");
    throw new JsonRdbError(
      `export "${exportName}" not found in ${schemaPath} (available exports: ${available || "none"})`,
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new JsonRdbError(
      `export "${exportName}" in ${schemaPath} is not a schema object (export the return value of defineSchema())`,
    );
  }
  const meta = (value as { _?: { tables?: unknown; constraints?: unknown } })._;
  if (
    meta === undefined ||
    typeof meta !== "object" ||
    meta === null ||
    !(meta.tables instanceof Map) ||
    !(meta.constraints instanceof Map)
  ) {
    throw new JsonRdbError(
      `export "${exportName}" in ${schemaPath} is not the return value of defineSchema()`,
    );
  }
  return value as Schema<SchemaTables>;
}

async function runCheck(args: ParsedArgs): Promise<number> {
  const schemaPath = args.options.get("schema");
  const dataDir = args.options.get("data");
  const exportName = args.options.get("export") ?? "schema";
  const asJson = args.flags.has("json");

  if (schemaPath === undefined) {
    console.error("steledb check: --schema <path> is required");
    return 2;
  }
  if (dataDir === undefined) {
    console.error("steledb check: --data <dir> is required");
    return 2;
  }

  const schema = await loadSchema(schemaPath, exportName);

  if (asJson) {
    const noop = () => {};
    const result = await runIntegrityCheck({ schema, dataDir, log: noop, error: noop });
    const payload = result.ok
      ? { ok: true as const, errors: [] as const }
      : { ok: false as const, errors: result.errors };
    console.log(JSON.stringify(payload));
    return result.ok ? 0 : 1;
  }

  const result = await runIntegrityCheck({ schema, dataDir });
  return result.ok ? 0 : 1;
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`steledb: ${(e as Error).message}`);
    printHelp();
    return 2;
  }

  const { subcommand } = args;
  if (
    subcommand === undefined ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printHelp();
    return subcommand === undefined ? 2 : 0;
  }

  try {
    if (subcommand === "check") {
      return await runCheck(args);
    }
    console.error(`steledb: unknown subcommand "${subcommand}"`);
    printHelp();
    return 2;
  } catch (e) {
    if (e instanceof JsonRdbError) {
      console.error(`steledb: ${e.message}`);
      return 1;
    }
    console.error(e);
    return 1;
  }
}

const exitCode = await main();
process.exit(exitCode);
