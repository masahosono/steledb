import { describe, expect, test } from "vitest";
import { catalogSchema } from "../testing/catalog-schema.js";
import { blankRow, buildStudioMeta, tableKeysOf, typeLabelOf } from "./meta.js";

const meta = buildStudioMeta(catalogSchema, {
  readOnly: false,
  fileFor: (tableKey) => `${tableKey}.json`,
});

function tableOf(key: string) {
  const table = meta.tables.find((candidate) => candidate.key === key);
  if (table === undefined) throw new Error(`no table meta for "${key}"`);
  return table;
}

describe("buildStudioMeta", () => {
  test("covers every table of the schema, in declaration order", () => {
    expect(meta.tables.map((table) => table.key)).toEqual(tableKeysOf(catalogSchema));
    expect(meta.readOnly).toBe(false);
  });

  test("carries the column constraints the grid renders as badges", () => {
    const columns = new Map(tableOf("videos").columns.map((column) => [column.key, column]));
    expect(columns.get("id")).toMatchObject({ primaryKey: true, unique: true, kind: "string" });
    expect(columns.get("slug")).toMatchObject({ primaryKey: false, unique: true });
    expect(columns.get("notes")).toMatchObject({ optional: true });
    expect(columns.get("kind")).toMatchObject({
      kind: "enum",
      enumValues: ["pv-collection", "live-video"],
    });
    expect(columns.get("coveredEvents")?.composite).toBe(true);
    expect(columns.get("title")?.composite).toBe(false);
  });

  test("carries the table-level composite uniques", () => {
    expect(tableOf("songRankings").compositeUniques).toEqual([["year", "rank"]]);
    expect(tableOf("videos").compositeUniques).toEqual([]);
  });

  test("flattens foreign keys at every nesting depth", () => {
    const paths = tableOf("videos").references.map((reference) => reference.pathString);
    expect(paths).toEqual(
      expect.arrayContaining([
        "coveredLiveIds[]", // scalar array element
        "coveredEvents[].eventId", // inside an array of objects
        "coveredEvents[].tracks[].songId", // doubly nested
      ]),
    );

    const nested = tableOf("videos").references.find(
      (reference) => reference.pathString === "coveredEvents[].tracks[].songId",
    );
    expect(nested).toMatchObject({
      path: ["coveredEvents", "[]", "tracks", "[]", "songId"],
      column: "coveredEvents",
      topLevel: false,
      targetTable: "songs",
      targetColumn: "id",
    });
  });

  test("marks a top-level foreign key on the column itself", () => {
    const columns = new Map(tableOf("events").columns.map((column) => [column.key, column]));
    expect(columns.get("venueId")?.reference).toEqual({ table: "venues", column: "id" });
    expect(columns.get("liveId")?.reference).toEqual({ table: "lives", column: "id" });
    expect(columns.get("name")?.reference).toBeUndefined();
  });

  test("hangs nested foreign keys off their top-level column", () => {
    const coveredEvents = tableOf("videos").columns.find(
      (column) => column.key === "coveredEvents",
    );
    expect(coveredEvents?.reference).toBeUndefined();
    expect(coveredEvents?.nestedReferences.map((reference) => reference.pathString)).toEqual([
      "coveredEvents[].eventId",
      "coveredEvents[].tracks[].songId",
    ]);
  });

  test("inverts the graph into referencedBy", () => {
    const incoming = tableOf("songs").referencedBy;
    expect(incoming).toEqual(
      expect.arrayContaining([
        {
          fromTable: "setlists",
          path: ["items", "[]", "songId"],
          pathString: "items[].songId",
          column: "id",
        },
        {
          fromTable: "videos",
          path: ["coveredEvents", "[]", "tracks", "[]", "songId"],
          pathString: "coveredEvents[].tracks[].songId",
          column: "id",
        },
      ]),
    );
    expect(incoming.every((reference) => reference.column === "id")).toBe(true);
  });

  test("a table nobody points at has no incoming references", () => {
    expect(tableOf("announcements").referencedBy).toEqual([]);
    expect(tableOf("announcements").references).toEqual([]);
  });

  test("records the primary key, uniques and backing file", () => {
    expect(tableOf("lives")).toMatchObject({
      pk: "id",
      uniques: expect.arrayContaining(["id", "slug"]),
      file: "lives.json",
      name: "lives",
    });
    // setlists is keyed by a foreign key, which is a primary key all the same
    expect(tableOf("setlists").pk).toBe("liveEventId");
  });

  test("fileFor decides the file name shown for a table", () => {
    const renamed = buildStudioMeta(catalogSchema, {
      readOnly: true,
      fileFor: (tableKey) => `${tableKey}-data.json`,
    });
    expect(renamed.tables[0]?.file).toBe("artists-data.json");
    expect(renamed.readOnly).toBe(true);
  });

  test("picks label columns that are neither the key nor a foreign key", () => {
    expect(tableOf("artists").labelColumns).toEqual(["name"]);
    expect(tableOf("venues").labelColumns).toEqual(["name"]);
    expect(tableOf("events").labelColumns).not.toContain("venueId");
  });
});

describe("typeLabelOf", () => {
  test("renders arrays, enums and nullability", () => {
    const columns = new Map(tableOf("venues").columns.map((column) => [column.key, column]));
    expect(columns.get("alias")?.typeLabel).toBe("string[]");
    expect(columns.get("capacity")?.typeLabel).toBe("number | null");
    expect(columns.get("latlon")?.typeLabel).toBe("object | null");
    expect(tableOf("events").columns.find((c) => c.key === "kind")?.typeLabel).toBe("enum");
    expect(tableOf("videos").columns.find((c) => c.key === "coveredEvents")?.typeLabel).toBe(
      "object[]",
    );
  });

  test("works directly on a column definition", () => {
    const def = catalogSchema._.tables.get("venues")?._.shape.alias;
    expect(def).toBeDefined();
    expect(typeLabelOf(def as never)).toBe("string[]");
  });
});

describe("blankRow", () => {
  test("builds a row from the declared shape, skipping optional keys", () => {
    const row = blankRow(catalogSchema, "videos");
    expect(row).toEqual({
      id: "",
      slug: "",
      title: "",
      releaseDate: "",
      kind: "pv-collection", // the first enum member
      coveredLiveIds: [],
      coveredEvents: [],
    });
    expect(row).not.toHaveProperty("notes"); // optional
  });

  test("uses null for nullable columns and recurses into objects", () => {
    expect(blankRow(catalogSchema, "venues")).toEqual({
      id: "",
      name: "",
      alias: [],
      latlon: null,
      capacity: null,
    });
  });

  test("returns an empty object for an unknown table", () => {
    expect(blankRow(catalogSchema, "nope")).toEqual({});
  });
});
