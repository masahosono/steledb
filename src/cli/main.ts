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
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SteleDbError } from "../errors.js";
import { runIntegrityCheck } from "../node/index.js";
import type { Schema, SchemaTables } from "../schema.js";
import { startStudio } from "../studio/index.js";

const BOOTSTRAP_ENV = "STELEDB_CLI_BOOTSTRAP";

/**
 * Relaunches this file with type stripping enabled and mirrors the child's
 * outcome. Signals are forwarded rather than the child being spawned
 * synchronously, because `steledb studio` runs until it is stopped and a
 * `kill` aimed at the CLI has to bring the server down with it.
 */
function bootstrap(): Promise<never> {
  const child = spawn(
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

  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);

  return new Promise<never>(() => {
    child.on("error", (error) => {
      console.error(`steledb: failed to spawn the child process: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      process.exit(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
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
      throw new SteleDbError(`unexpected positional argument: ${arg}`);
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
  steledb check  --schema <path> --data <dir> [--export <name>] [--json]
  steledb studio --schema <path> --data <dir> [--export <name>] [--port <n>] [--open] [--read-only]
  steledb help

Commands:
  check    validate a directory of JSON data against a schema
  studio   open a local GUI console for browsing and editing the data
  help     show this help

Common options:
  --schema <path>   a .ts / .js file exporting the return value of defineSchema()
  --data <dir>      a directory holding one JSON file per table
  --export <name>   the export name of the schema (defaults to "schema")

Options for 'check':
  --json            print the result as JSON (machine readable, for CI)

Options for 'studio':
  --port <n>        the port to listen on (defaults to 4321, falls back when taken)
  --open            open the studio in the default browser
  --read-only       serve the data without allowing edits
`);
}

async function loadSchema(schemaPath: string, exportName: string): Promise<Schema<SchemaTables>> {
  const url = pathToFileURL(schemaPath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (cause) {
    throw new SteleDbError(`cannot load the schema file: ${schemaPath}`, { cause });
  }
  const value = mod[exportName];
  if (value === undefined) {
    const available = Object.keys(mod)
      .filter((k) => k !== "default")
      .join(", ");
    throw new SteleDbError(
      `export "${exportName}" not found in ${schemaPath} (available exports: ${available || "none"})`,
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new SteleDbError(
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
    throw new SteleDbError(
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

/** Opens a URL in the platform's default browser, best effort. */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // opening a browser is a convenience; the URL is printed either way
  }
}

/**
 * Starts the studio server and keeps running until interrupted. The returned
 * promise deliberately never resolves on the happy path — SIGINT / SIGTERM shut
 * the server down and exit the process.
 */
async function runStudio(args: ParsedArgs): Promise<number> {
  const schemaPath = args.options.get("schema");
  const dataDir = args.options.get("data");
  const exportName = args.options.get("export") ?? "schema";
  const portOption = args.options.get("port");

  if (schemaPath === undefined) {
    console.error("steledb studio: --schema <path> is required");
    return 2;
  }
  if (dataDir === undefined) {
    console.error("steledb studio: --data <dir> is required");
    return 2;
  }
  let port: number | undefined;
  if (portOption !== undefined) {
    port = Number(portOption);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`steledb studio: --port must be a port number, got "${portOption}"`);
      return 2;
    }
  }

  const schema = await loadSchema(schemaPath, exportName);
  const readOnly = args.flags.has("read-only");
  const studio = await startStudio({
    schema,
    dataDir,
    ...(port === undefined ? {} : { port }),
    readOnly,
  });

  const errorCount = studio.workspace.errors.length;
  const health = errorCount === 0 ? "data integrity OK" : `${errorCount} integrity error(s)`;
  console.log(`steledb studio${readOnly ? " (read-only)" : ""} is running`);
  console.log(`  ${studio.url}`);
  console.log(`  ${studio.workspace.meta.tables.length} tables · ${health}`);
  console.log("  press Ctrl-C to stop");

  if (args.flags.has("open")) openInBrowser(studio.url);

  return new Promise<number>((resolve) => {
    const shutdown = () => {
      void studio.close().then(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
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
    if (subcommand === "studio") {
      return await runStudio(args);
    }
    console.error(`steledb: unknown subcommand "${subcommand}"`);
    printHelp();
    return 2;
  } catch (e) {
    if (e instanceof SteleDbError) {
      console.error(`steledb: ${e.message}`);
      return 1;
    }
    console.error(e);
    return 1;
  }
}

if (process.env[BOOTSTRAP_ENV] !== "1") {
  await bootstrap();
}

const exitCode = await main();
process.exit(exitCode);
