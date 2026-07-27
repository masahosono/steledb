import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { JsonRdbError } from "../errors.js";
import {
  StudioConflictError,
  detectFormat,
  readTableFile,
  revisionOf,
  scanArrayLayout,
  serializeRows,
  writeTableFile,
} from "./io.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "steledb-studio-io-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a file, reads it through readTableFile, saves it back unchanged. */
async function roundTrip(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text, "utf-8");
  const file = await readTableFile(dir, name.replace(/\.json$/, ""));
  await writeTableFile({
    path: file.path,
    rows: file.rows,
    format: file.format,
    original: { text: file.text, rows: file.rows },
  });
  return readFile(path, "utf-8");
}

describe("detectFormat", () => {
  test("reads the indent width off the first indented line", () => {
    expect(detectFormat('[\n  { "a": 1 }\n]\n')).toEqual({ indent: 2, trailingNewline: true });
    expect(detectFormat('[\n    { "a": 1 }\n]\n')).toEqual({ indent: 4, trailingNewline: true });
    expect(detectFormat('[\n\t{ "a": 1 }\n]\n')).toEqual({ indent: "\t", trailingNewline: true });
  });

  test("notices a missing trailing newline", () => {
    expect(detectFormat('[\n  { "a": 1 }\n]')).toEqual({ indent: 2, trailingNewline: false });
  });

  test("falls back to two spaces when nothing is indented", () => {
    expect(detectFormat("[]")).toEqual({ indent: 2, trailingNewline: false });
  });
});

describe("round trips", () => {
  test("a save with no edits leaves the file byte for byte identical", async () => {
    const cases: Readonly<Record<string, string>> = {
      "two-space.json": '[\n  {\n    "id": "a",\n    "n": 1\n  }\n]\n',
      "four-space.json": '[\n    {\n        "id": "a",\n        "n": 1\n    }\n]\n',
      "tabs.json": '[\n\t{\n\t\t"id": "a"\n\t}\n]\n',
      "no-trailing-newline.json": '[\n  {\n    "id": "a"\n  }\n]',
      "compact-rows.json": '[\n  { "id": "a", "n": 1 },\n  { "id": "b", "n": 2 }\n]\n',
      "single-line.json": '[{ "id": "a" }, { "id": "b" }]\n',
      "empty.json": "[]\n",
    };
    for (const [name, text] of Object.entries(cases)) {
      expect(await roundTrip(name, text), name).toBe(text);
    }
  });

  test("keeps key order, including keys the schema would order differently", async () => {
    const text = '[\n  {\n    "z": 1,\n    "a": 2,\n    "m": 3\n  }\n]\n';
    expect(await roundTrip("key-order.json", text)).toBe(text);
  });

  test("preserves values that would trip a naive scanner", async () => {
    const text = `[
  { "id": "a", "text": "a string with , and ] and { inside" },
  { "id": "b", "text": "an escaped quote \\" then a bracket ]" }
]
`;
    expect(await roundTrip("tricky-strings.json", text)).toBe(text);
  });
});

describe("serializeRows", () => {
  const original = {
    text: '[\n  { "id": "a", "tags": ["x", "y"] },\n  {\n    "id": "b",\n    "tags": []\n  }\n]\n',
    rows: [
      { id: "a", tags: ["x", "y"] },
      { id: "b", tags: [] },
    ],
  };
  const format = { indent: 2, trailingNewline: true } as const;

  test("only re-formats the row that changed", () => {
    const rows = [original.rows[0], { id: "b", tags: ["new"] }];
    const out = serializeRows(rows, format, original);
    // the untouched row keeps its hand-written single-line form
    expect(out).toContain('{ "id": "a", "tags": ["x", "y"] }');
    expect(JSON.parse(out)).toEqual(rows);
  });

  test("inserting at the front leaves the existing rows untouched", () => {
    const rows = [{ id: "z", tags: [] }, ...original.rows];
    const out = serializeRows(rows, format, original);
    expect(out).toContain('{ "id": "a", "tags": ["x", "y"] }');
    expect(out).toContain('    "id": "b",');
    expect(JSON.parse(out)).toEqual(rows);
  });

  test("deleting a row leaves the survivors untouched", () => {
    const rows = [original.rows[1]];
    const out = serializeRows(rows, format, original);
    expect(out).toContain('    "id": "b",');
    expect(out).not.toContain('"id": "a"');
    expect(JSON.parse(out)).toEqual(rows);
  });

  test("reordering reuses each row's own text", () => {
    const rows = [original.rows[1], original.rows[0]];
    const out = serializeRows(rows, format, original);
    expect(out).toContain('{ "id": "a", "tags": ["x", "y"] }');
    expect(JSON.parse(out)).toEqual(rows);
  });

  test("indents a brand new row to match the file", () => {
    const rows = [...original.rows, { id: "c", tags: ["q"] }];
    const out = serializeRows(rows, format, original);
    expect(out).toContain('\n  {\n    "id": "c",');
    expect(JSON.parse(out)).toEqual(rows);
  });

  test("without the original it falls back to a plain stringify", () => {
    expect(serializeRows([{ a: 1 }], format)).toBe('[\n  {\n    "a": 1\n  }\n]\n');
    expect(serializeRows([{ a: 1 }], { indent: 2, trailingNewline: false })).toBe(
      '[\n  {\n    "a": 1\n  }\n]',
    );
  });

  test("emptying a table falls back rather than leaving stray whitespace", () => {
    expect(serializeRows([], format, original)).toBe("[]\n");
  });
});

describe("scanArrayLayout", () => {
  test("splits elements and the whitespace around them", () => {
    const layout = scanArrayLayout('[\n  { "a": 1 },\n  { "a": 2 }\n]\n');
    expect(layout).toMatchObject({
      prefix: "[\n  ",
      elements: ['{ "a": 1 }', '{ "a": 2 }'],
      separators: [",\n  "],
      suffix: "\n]\n",
      pad: "  ",
    });
  });

  test("gives up on input it cannot split safely", () => {
    expect(scanArrayLayout("[]")).toBeNull(); // no elements to reuse
    expect(scanArrayLayout('{ "not": "an array" }')).toBeNull();
    expect(scanArrayLayout("[1, 2")).toBeNull(); // unterminated
  });
});

describe("writeTableFile", () => {
  test("refuses to overwrite a file that changed underneath it", async () => {
    const path = join(dir, "conflict.json");
    await writeFile(path, '[\n  { "id": "a" }\n]\n', "utf-8");
    const stale = revisionOf("something else entirely");
    await expect(
      writeTableFile({
        path,
        rows: [{ id: "b" }],
        format: { indent: 2, trailingNewline: true },
        expectedRevision: stale,
      }),
    ).rejects.toBeInstanceOf(StudioConflictError);
    // the file is untouched
    expect(await readFile(path, "utf-8")).toBe('[\n  { "id": "a" }\n]\n');
  });

  test("accepts a write based on the current revision", async () => {
    const path = join(dir, "ok.json");
    await writeFile(path, '[\n  { "id": "a" }\n]\n', "utf-8");
    const file = await readTableFile(dir, "ok");
    const result = await writeTableFile({
      path,
      rows: [{ id: "b" }],
      format: file.format,
      expectedRevision: file.revision,
    });
    expect(result.revision).toBe(revisionOf(result.text));
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual([{ id: "b" }]);
  });

  test("leaves no temp file behind", async () => {
    const path = join(dir, "atomic.json");
    await writeFile(path, "[]\n", "utf-8");
    await writeTableFile({
      path,
      rows: [{ id: "a" }],
      format: { indent: 2, trailingNewline: true },
    });
    const entries = await readdir(dir);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readTableFile", () => {
  test("reports a missing file, bad JSON and a non-array top level distinctly", async () => {
    await expect(readTableFile(dir, "absent")).rejects.toThrow(/cannot read the file/);

    await writeFile(join(dir, "broken.json"), "{ nope", "utf-8");
    await expect(readTableFile(dir, "broken")).rejects.toThrow(/failed to parse the JSON/);

    await writeFile(join(dir, "object.json"), '{ "a": 1 }', "utf-8");
    await expect(readTableFile(dir, "object")).rejects.toThrow(/top level .* is not an array/);
  });

  test("honours a custom fileFor mapping", async () => {
    await writeFile(join(dir, "digital-singles.json"), "[]\n", "utf-8");
    const file = await readTableFile(dir, "digitalSingles", () => "digital-singles.json");
    expect(file.tableKey).toBe("digitalSingles");
    expect(file.rows).toEqual([]);
  });

  test("a parse failure is a JsonRdbError", async () => {
    await writeFile(join(dir, "bad2.json"), "nope", "utf-8");
    await expect(readTableFile(dir, "bad2")).rejects.toBeInstanceOf(JsonRdbError);
  });
});
