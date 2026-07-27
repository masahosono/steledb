import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
/**
 * End-to-end tests for the studio server. Each case gets its own temp data
 * directory and its own server on an ephemeral port, so tests that write files
 * cannot see each other's edits.
 */
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { catalogSchema, cloneValidData } from "../testing/catalog-schema.js";
import { type StudioServer, startStudio } from "./server.js";

const TOKEN = "test-token";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Harness {
  readonly studio: StudioServer;
  readonly dir: string;
  readonly base: string;
  api(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<any>;
}

async function studioHarness(
  options: { readOnly?: boolean; watch?: boolean } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "steledb-studio-srv-"));
  const data = cloneValidData();
  for (const [tableKey, rows] of Object.entries(data)) {
    await writeFile(join(dir, `${tableKey}.json`), `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
  }
  const studio = await startStudio({
    schema: catalogSchema,
    dataDir: dir,
    port: 0,
    token: TOKEN,
    watch: options.watch ?? false,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  cleanups.push(async () => {
    await studio.close();
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${studio.port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { "X-Steledb-Token": TOKEN, ...(init.headers ?? {}) },
    });
  return {
    studio,
    dir,
    base,
    api,
    json: async (path, init) => (await api(path, init)).json(),
  };
}

/** Response.json() is typed as unknown; tests assert on the shape themselves. */
function bodyOf(response: Response): Promise<any> {
  return response.json();
}

/** A raw request, so the Host header can be forged the way an attacker would. */
function rawRequest(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startStudio", () => {
  test("binds loopback and hands the token over in the URL fragment", async () => {
    const { studio } = await studioHarness();
    expect(studio.url).toBe(`http://127.0.0.1:${studio.port}/#t=${TOKEN}`);
    expect(studio.port).toBeGreaterThan(0);
  });

  test("generates a random token when none is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steledb-studio-tok-"));
    for (const [tableKey, rows] of Object.entries(cloneValidData())) {
      await writeFile(join(dir, `${tableKey}.json`), JSON.stringify(rows), "utf-8");
    }
    const studio = await startStudio({
      schema: catalogSchema,
      dataDir: dir,
      port: 0,
      watch: false,
    });
    cleanups.push(async () => {
      await studio.close();
      await rm(dir, { recursive: true, force: true });
    });
    expect(studio.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("fails to start when a data file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steledb-studio-empty-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await expect(
      startStudio({ schema: catalogSchema, dataDir: dir, port: 0, watch: false }),
    ).rejects.toThrow(/cannot read the file/);
  });
});

describe("authentication", () => {
  test("rejects an API call with no token", async () => {
    const { base } = await studioHarness();
    const response = await fetch(`${base}/api/state`);
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error).toMatch(/token/);
  });

  test("rejects a wrong token", async () => {
    const { base } = await studioHarness();
    const response = await fetch(`${base}/api/state`, { headers: { "X-Steledb-Token": "nope" } });
    expect(response.status).toBe(403);
  });

  test("accepts the token as a query parameter, for EventSource", async () => {
    const { base } = await studioHarness();
    const response = await fetch(`${base}/api/errors?token=${TOKEN}`);
    expect(response.status).toBe(200);
  });

  test("rejects a forged Host header, which is the DNS rebinding guard", async () => {
    const { studio } = await studioHarness();
    expect(await rawRequest(studio.port, "/api/state", "evil.example.com")).toBe(403);
    expect(await rawRequest(studio.port, "/", "evil.example.com")).toBe(403);
    expect(await rawRequest(studio.port, "/", `localhost:${studio.port}`)).toBe(200);
  });
});

describe("static assets", () => {
  test("serves the front end", async () => {
    const { api } = await studioHarness();
    const index = await api("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    expect(await index.text()).toContain("steledb");

    const script = await api("/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);

    const style = await api("/studio.css");
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toMatch(/text\/css/);
  });

  test("refuses to walk out of the assets directory", async () => {
    const { base } = await studioHarness();
    const response = await fetch(`${base}/../../package.json`, { redirect: "manual" });
    // fetch normalises "..", so the request lands on a path that simply is not there
    expect([403, 404]).toContain(response.status);
  });

  test("404s an unknown asset and an unknown endpoint", async () => {
    const { api } = await studioHarness();
    expect((await api("/nope.js")).status).toBe(404);
    expect((await api("/api/nope")).status).toBe(404);
  });
});

describe("/api/state", () => {
  test("returns the schema meta, row counts and validation errors", async () => {
    const { json } = await studioHarness();
    const state = await json("/api/state");
    expect(state.meta.tables.map((table: any) => table.key)).toContain("songs");
    expect(state.meta.readOnly).toBe(false);
    const songs = state.tables.find((table: any) => table.key === "songs");
    expect(songs.rowCount).toBe(cloneValidData().songs.length);
    expect(songs.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(state.errors).toEqual([]);
  });
});

describe("/api/table", () => {
  test("returns the rows and the revision", async () => {
    const { json } = await studioHarness();
    const table = await json("/api/table/artists");
    expect(table.rows).toEqual(cloneValidData().artists);
    expect(table.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(table.file).toMatch(/artists\.json$/);
  });

  test("404s an unknown table", async () => {
    const { api } = await studioHarness();
    expect((await api("/api/table/nope")).status).toBe(404);
  });

  test("writes rows back to disk and revalidates", async () => {
    const { api, json, dir } = await studioHarness();
    const before = await json("/api/table/artists");
    const rows = [...before.rows, { id: "a-new", name: "Added By Studio" }];

    const response = await api("/api/table/artists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, revision: before.revision }),
    });
    expect(response.status).toBe(200);
    const result = await bodyOf(response);
    expect(result.errors).toEqual([]);
    expect(result.revision).not.toBe(before.revision);

    const onDisk = JSON.parse(await readFile(join(dir, "artists.json"), "utf-8"));
    expect(onDisk).toEqual(rows);
  });

  test("reports the integrity errors an edit introduces, but still saves", async () => {
    const { api, json, dir } = await studioHarness();
    const before = await json("/api/table/artists");
    // duplicate the first artist's id, which breaks the primary key
    const first = before.rows[0];
    const rows = [...before.rows, { id: first.id, name: "Duplicate" }];

    const result = await bodyOf(
      await api("/api/table/artists", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, revision: before.revision }),
      }),
    );

    expect(result.errors.some((error: any) => error.code === "DUPLICATE_KEY")).toBe(true);
    const onDisk = JSON.parse(await readFile(join(dir, "artists.json"), "utf-8"));
    expect(onDisk).toHaveLength(rows.length);
  });

  test("409s a write based on a stale revision", async () => {
    const { api, json } = await studioHarness();
    const before = await json("/api/table/artists");
    const response = await api("/api/table/artists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: before.rows, revision: "0000000000000000" }),
    });
    expect(response.status).toBe(409);
    expect((await bodyOf(response)).error).toMatch(/changed outside the studio/);
  });

  test("rejects a malformed body", async () => {
    const { api } = await studioHarness();
    const response = await api("/api/table/artists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(response.status).toBe(400);
  });

  test("405s anything but GET and PUT", async () => {
    const { api } = await studioHarness();
    expect((await api("/api/table/artists", { method: "DELETE" })).status).toBe(405);
  });
});

describe("read-only mode", () => {
  test("serves data but refuses writes", async () => {
    const { api, json } = await studioHarness({ readOnly: true });
    expect((await json("/api/state")).meta.readOnly).toBe(true);
    expect((await api("/api/table/artists")).status).toBe(200);

    const response = await api("/api/table/artists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [] }),
    });
    expect(response.status).toBe(405);
    expect((await bodyOf(response)).error).toMatch(/read-only/);
  });
});

describe("/api/row", () => {
  test("resolves outgoing foreign keys, including nested ones", async () => {
    const { json } = await studioHarness();
    const detail = await json("/api/row/videos/0");
    const paths = detail.outgoing.map((link: any) => link.pathString);
    expect(paths.some((path: string) => /^coveredEvents\[\d+\]\.eventId$/.test(path))).toBe(true);
    expect(detail.outgoing.every((link: any) => link.resolved !== null)).toBe(true);
    const resolved = detail.outgoing[0];
    expect(resolved.resolved).toMatchObject({
      table: resolved.targetTable,
      rowIndex: expect.any(Number),
    });
  });

  test("lists the rows pointing back at this one", async () => {
    const { json } = await studioHarness();
    const detail = await json("/api/row/songs/0");
    expect(detail.backlinks.length).toBeGreaterThan(0);
    const group = detail.backlinks[0];
    expect(group.column).toBe("id");
    expect(group.refs[0]).toMatchObject({
      table: expect.any(String),
      rowIndex: expect.any(Number),
      rowLabel: expect.any(String),
      pathString: expect.any(String),
    });
  });

  test("reports an unresolved foreign key as null rather than omitting it", async () => {
    const { api, json } = await studioHarness();
    const before = await json("/api/table/setlists");
    const rows = structuredClone(before.rows);
    rows[0].items[0].songId = "no-such-song";
    await api("/api/table/setlists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, revision: before.revision }),
    });

    const detail = await json("/api/row/setlists/0");
    const broken = detail.outgoing.find((link: any) => link.value === "no-such-song");
    expect(broken).toBeDefined();
    expect(broken.resolved).toBeNull();
  });

  test("404s an out-of-range row and an unknown table", async () => {
    const { api } = await studioHarness();
    expect((await api("/api/row/songs/9999")).status).toBe(404);
    expect((await api("/api/row/nope/0")).status).toBe(404);
  });
});

describe("/api/lookup", () => {
  test("maps a foreign key value to a row index", async () => {
    const { json } = await studioHarness();
    const artists = cloneValidData().artists;
    const target = artists[1];
    const found = await json(`/api/lookup?table=artists&column=id&value=${target?.id}`);
    expect(found).toEqual({ table: "artists", rowIndex: 1 });
  });

  test("404s a value nothing matches, and 400s a missing parameter", async () => {
    const { api } = await studioHarness();
    expect((await api("/api/lookup?table=artists&column=id&value=zzz")).status).toBe(404);
    expect((await api("/api/lookup?table=artists")).status).toBe(400);
  });
});

describe("/api/blank-row", () => {
  test("returns a row built from the schema shape", async () => {
    const { json } = await studioHarness();
    const { row } = await json("/api/blank-row/venues");
    expect(row).toEqual({ id: "", name: "", alias: [], latlon: null, capacity: null });
  });
});

describe("/api/events", () => {
  test("opens a stream and announces a save", async () => {
    const { base, api, json } = await studioHarness();
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events?token=${TOKEN}`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // the server greets with a comment frame as soon as the stream opens
    expect(decoder.decode((await reader.read()).value)).toContain(": connected");

    const before = await json("/api/table/artists");
    await api("/api/table/artists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: before.rows, revision: before.revision }),
    });

    const frame = decoder.decode((await reader.read()).value);
    expect(JSON.parse(frame.replace(/^data: /, ""))).toEqual({ type: "saved", table: "artists" });

    controller.abort();
  });
});
