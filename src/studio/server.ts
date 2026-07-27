/**
 * The studio's HTTP layer: a small JSON API plus the static front end, bound to
 * the loopback interface only.
 *
 * Because this server can rewrite files on disk, three things guard it:
 * loopback-only binding, a per-run token that every /api call has to present,
 * and a Host header check (a page on the open internet can resolve a name to
 * 127.0.0.1, but it cannot forge the Host header the browser sends).
 */
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SteleDbError, formatErrorPath } from "../errors.js";
import { hitsAtPath, isPlainObject } from "../paths.js";
import type { Schema, SchemaTables } from "../schema.js";
import type { ValidateOptions } from "../validate.js";
import { StudioConflictError } from "./io.js";
import { blankRow } from "./meta.js";
import type { RowRef } from "./refs.js";
import { Workspace } from "./workspace.js";

const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));
const DEFAULT_PORT = 4321;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface StartStudioOptions<S extends SchemaTables = SchemaTables> {
  readonly schema: Schema<S>;
  readonly dataDir: string | URL;
  readonly fileFor?: (tableKey: string) => string;
  /** Preferred port. Falls back to an ephemeral port when it is taken. Pass 0 for "any" */
  readonly port?: number;
  readonly readOnly?: boolean;
  readonly validateOptions?: ValidateOptions;
  /** Fixed token, for tests. A random one is generated otherwise */
  readonly token?: string;
  /** Watch the data directory and push changes over SSE. Defaults to true */
  readonly watch?: boolean;
}

export interface StudioServer {
  /** The URL to open, carrying the token in the fragment so it stays out of logs */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly workspace: Workspace;
  close(): Promise<void>;
}

/** Boots a studio server: loads the data, validates it, then starts listening. */
export async function startStudio<S extends SchemaTables>(
  options: StartStudioOptions<S>,
): Promise<StudioServer> {
  const workspace = new Workspace<S>({
    schema: options.schema,
    dataDir: options.dataDir,
    ...(options.fileFor === undefined ? {} : { fileFor: options.fileFor }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.validateOptions === undefined ? {} : { validateOptions: options.validateOptions }),
  });
  await workspace.load();

  const token = options.token ?? randomUUID();
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res, { workspace, token, clients }).catch((error: unknown) => {
      if (!res.headersSent) {
        const status = error instanceof StudioConflictError ? 409 : 500;
        sendJson(res, status, { error: messageOf(error) });
      } else {
        res.end();
      }
    });
  });

  const port = await listen(server, options.port ?? DEFAULT_PORT);

  let watcher: FSWatcher | undefined;
  if (options.watch !== false) {
    watcher = startWatching(workspace, clients);
  }

  return {
    url: `http://127.0.0.1:${port}/#t=${token}`,
    port,
    token,
    workspace,
    close: () =>
      new Promise<void>((resolve) => {
        watcher?.close();
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Listens on the preferred port, retrying on an ephemeral one when it is taken. */
function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && preferred !== 0) {
        server.removeListener("error", onError);
        server.listen(0, "127.0.0.1", () => resolve(portOf(server)));
        server.once("error", reject);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferred, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(portOf(server));
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new SteleDbError("the studio server did not bind to a TCP port");
  }
  return address.port;
}

interface Context {
  readonly workspace: Workspace;
  readonly token: string;
  readonly clients: Set<ServerResponse>;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (!hostIsLocal(req)) {
    sendJson(res, 403, { error: "the studio only accepts requests addressed to localhost" });
    return;
  }

  if (!path.startsWith("/api/")) {
    await serveAsset(path, res);
    return;
  }

  if (!tokenMatches(req, url, ctx.token)) {
    sendJson(res, 403, {
      error: "missing or invalid studio token — open the URL printed at startup",
    });
    return;
  }

  if (path === "/api/events") {
    openEventStream(req, res, ctx.clients);
    return;
  }
  if (path === "/api/state" && req.method === "GET") {
    sendJson(res, 200, stateOf(ctx.workspace));
    return;
  }
  if (path === "/api/errors" && req.method === "GET") {
    sendJson(res, 200, { errors: ctx.workspace.errors });
    return;
  }

  const tableMatch = /^\/api\/table\/([^/]+)$/.exec(path);
  if (tableMatch !== null) {
    await handleTable(req, res, ctx, decodeURIComponent(tableMatch[1] as string));
    return;
  }

  const rowMatch = /^\/api\/row\/([^/]+)\/(\d+)$/.exec(path);
  if (rowMatch !== null && req.method === "GET") {
    handleRow(res, ctx, decodeURIComponent(rowMatch[1] as string), Number(rowMatch[2]));
    return;
  }

  const blankMatch = /^\/api\/blank-row\/([^/]+)$/.exec(path);
  if (blankMatch !== null && req.method === "GET") {
    const tableKey = decodeURIComponent(blankMatch[1] as string);
    sendJson(res, 200, { row: blankRow(ctx.workspace.schema, tableKey) });
    return;
  }

  if (path === "/api/lookup" && req.method === "GET") {
    handleLookup(url, res, ctx);
    return;
  }

  sendJson(res, 404, { error: `no such endpoint: ${path}` });
}

function stateOf(workspace: Workspace) {
  return {
    meta: workspace.meta,
    tables: workspace.meta.tables.map((table) => ({
      key: table.key,
      rowCount: workspace.fileOf(table.key)?.rows.length ?? 0,
      revision: workspace.fileOf(table.key)?.revision ?? "",
    })),
    errors: workspace.errors,
  };
}

async function handleTable(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  tableKey: string,
): Promise<void> {
  const file = ctx.workspace.fileOf(tableKey);
  if (file === undefined) {
    sendJson(res, 404, { error: `unknown table "${tableKey}"` });
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, { rows: file.rows, revision: file.revision, file: file.path });
    return;
  }

  if (req.method !== "PUT") {
    sendJson(res, 405, { error: `${req.method} is not allowed on this endpoint` });
    return;
  }
  if (ctx.workspace.readOnly) {
    sendJson(res, 405, { error: "the studio is running in read-only mode" });
    return;
  }

  const body = await readJsonBody(req);
  if (!isPlainObject(body) || !Array.isArray(body.rows)) {
    sendJson(res, 400, { error: "the request body must be { rows: [...], revision?: string }" });
    return;
  }
  const expected = typeof body.revision === "string" ? body.revision : undefined;
  const result = await ctx.workspace.saveTable(tableKey, body.rows, expected);
  sendJson(res, 200, { revision: result.revision, errors: result.errors });
  broadcast(ctx.clients, { type: "saved", table: tableKey });
}

/**
 * One row with its links resolved in both directions: what its foreign keys
 * point at, and which rows point back at it.
 */
function handleRow(res: ServerResponse, ctx: Context, tableKey: string, rowIndex: number): void {
  const { workspace } = ctx;
  const file = workspace.fileOf(tableKey);
  const table = workspace.meta.tables.find((candidate) => candidate.key === tableKey);
  if (file === undefined || table === undefined) {
    sendJson(res, 404, { error: `unknown table "${tableKey}"` });
    return;
  }
  const row = file.rows[rowIndex];
  if (row === undefined) {
    sendJson(res, 404, { error: `${tableKey} has no row at index ${rowIndex}` });
    return;
  }

  const refs = workspace.refs;

  const outgoing: {
    pathString: string;
    value: unknown;
    targetTable: string;
    targetColumn: string;
    resolved: RowRef | null;
  }[] = [];
  for (const reference of table.references) {
    for (const hit of hitsOf(row, reference.path)) {
      if (hit.value === null || hit.value === undefined) continue;
      outgoing.push({
        pathString: hit.pathString,
        value: hit.value,
        targetTable: reference.targetTable,
        targetColumn: reference.targetColumn,
        resolved: refs.resolveRef(reference.targetTable, reference.targetColumn, hit.value) ?? null,
      });
    }
  }

  const backlinks: { column: string; value: unknown; refs: readonly RowRef[] }[] = [];
  const columns = new Set(table.referencedBy.map((incoming) => incoming.column));
  for (const column of columns) {
    const value = isPlainObject(row) ? row[column] : undefined;
    if (value === null || value === undefined) continue;
    const found = refs.backlinksOf(tableKey, column, value);
    if (found.length > 0) backlinks.push({ column, value, refs: found });
  }

  sendJson(res, 200, { row, rowIndex, outgoing, backlinks });
}

/** Resolves "which row of table X has column Y equal to Z", for foreign key jumps. */
function handleLookup(url: URL, res: ServerResponse, ctx: Context): void {
  const tableKey = url.searchParams.get("table");
  const column = url.searchParams.get("column");
  const raw = url.searchParams.get("value");
  if (tableKey === null || column === null || raw === null) {
    sendJson(res, 400, { error: "table, column and value are all required" });
    return;
  }
  const file = ctx.workspace.fileOf(tableKey);
  if (file === undefined) {
    sendJson(res, 404, { error: `unknown table "${tableKey}"` });
    return;
  }
  // The value arrives as a string; try it as a number too, since a numeric
  // primary key round-trips through the URL as text.
  const asNumber = Number(raw);
  const rowIndex =
    ctx.workspace.refs.resolve(tableKey, column, raw) ??
    (raw.trim() !== "" && !Number.isNaN(asNumber)
      ? ctx.workspace.refs.resolve(tableKey, column, asNumber)
      : undefined);
  if (rowIndex === undefined) {
    sendJson(res, 404, { error: `no row in ${tableKey} where ${column} = ${raw}` });
    return;
  }
  sendJson(res, 200, { table: tableKey, rowIndex });
}

/** hitsAtPath with the display form of each concrete path already computed. */
function hitsOf(row: unknown, path: readonly string[]) {
  return hitsAtPath(row, path).map((hit) => ({
    value: hit.value,
    pathString: formatErrorPath(hit.path),
  }));
}

// --- transport helpers -----------------------------------------------------

function hostIsLocal(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (host === undefined) return false;
  const name = host.split(":")[0] ?? "";
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function tokenMatches(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers["x-steledb-token"];
  if (typeof header === "string" && header === token) return true;
  // EventSource cannot set headers, so the SSE endpoint accepts a query param
  return url.searchParams.get("token") === token;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function serveAsset(path: string, res: ServerResponse): Promise<void> {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const resolved = normalize(join(ASSETS_DIR, relative));
  if (!resolved.startsWith(ASSETS_DIR)) {
    sendJson(res, 403, { error: "path traversal is not allowed" });
    return;
  }
  let content: Buffer;
  try {
    content = await readFile(resolved);
  } catch {
    sendJson(res, 404, { error: `not found: ${path}` });
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(resolved)] ?? "application/octet-stream",
    "Content-Length": content.byteLength,
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SteleDbError("the request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (text === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (cause) {
        reject(new SteleDbError(`the request body is not valid JSON: ${String(cause)}`));
      }
    });
    req.on("error", reject);
  });
}

// --- server-sent events ----------------------------------------------------

function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
  });
}

function broadcast(clients: Set<ServerResponse>, payload: unknown): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(line);
  }
}

/**
 * Watches the data directory and pushes a change event per table. A save made
 * by the studio itself also fires here, so the revision is compared before and
 * after the reload and an unchanged file is not announced.
 */
function startWatching(workspace: Workspace, clients: Set<ServerResponse>): FSWatcher | undefined {
  let pending: NodeJS.Timeout | undefined;
  const dirty = new Set<string>();

  const flush = (): void => {
    pending = undefined;
    const tables = [...dirty];
    dirty.clear();
    void (async () => {
      for (const tableKey of tables) {
        const before = workspace.fileOf(tableKey)?.revision;
        try {
          await workspace.reload(tableKey);
        } catch (error) {
          broadcast(clients, { type: "load-error", table: tableKey, message: messageOf(error) });
          continue;
        }
        if (workspace.fileOf(tableKey)?.revision === before) continue;
        broadcast(clients, { type: "table-changed", table: tableKey });
      }
    })();
  };

  try {
    return watch(workspace.dirPath, { persistent: false }, (_event, fileName) => {
      if (fileName === null) return;
      const tableKey = workspace.tableKeyForFile(String(fileName));
      if (tableKey === undefined) return;
      dirty.add(tableKey);
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(flush, 50);
    });
  } catch {
    // Watching is a convenience; a platform that cannot watch still serves fine
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
