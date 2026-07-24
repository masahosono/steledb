import { describe, expect, test } from "vitest";
import type { ValidationError } from "./errors.js";
import { catalogSchema, cloneValidData, validData } from "./testing/catalog-schema.js";
import { validate } from "./validate.js";

function errorsOf(data: ReturnType<typeof cloneValidData>): readonly ValidationError[] {
  return validate(catalogSchema, data).errors;
}

describe("validate: shape checks", () => {
  test("valid data produces no errors", () => {
    const result = validate(catalogSchema, validData);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("detects a primitive type mismatch", () => {
    const data = cloneValidData();
    (data.lives[0] as { year: unknown }).year = "2013";
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "SHAPE_MISMATCH",
      table: "lives",
      rowIndex: 0,
      pathString: "year",
      expected: "number",
      actual: "2013",
    });
  });

  test("detects null in a column that is not nullable", () => {
    const data = cloneValidData();
    (data.songs[0] as { title: unknown }).title = null;
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({ code: "SHAPE_MISMATCH", pathString: "title" });
    expect(errors[0]?.message).toContain("null is not allowed");
  });

  test("a null in a nullable column and a missing optional key both pass", () => {
    const data = cloneValidData();
    (data.songs[0] as { sortTitle: string | null }).sortTitle = null;
    Reflect.deleteProperty(data.videos[1] as object, "notes");
    expect(errorsOf(data)).toEqual([]);
  });

  test("detects a missing required key", () => {
    const data = cloneValidData();
    Reflect.deleteProperty(data.venues[0] as object, "name");
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "SHAPE_MISMATCH",
      table: "venues",
      pathString: "name",
    });
    expect(errors[0]?.message).toContain("a required key is missing");
  });

  test("detects a value outside an enum", () => {
    const data = cloneValidData();
    (data.events[0] as { kind: unknown }).kind = "secret_live";
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "SHAPE_MISMATCH",
      table: "events",
      pathString: "kind",
    });
    expect(errors[0]?.message).toContain("official_live");
  });

  test("detects keys absent from the schema (suppressed by unknownKeys: ignore)", () => {
    const data = cloneValidData();
    (data.artists[0] as Record<string, unknown>).nickname = "Ari";
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "UNKNOWN_KEY",
      key: "nickname",
      pathString: "nickname",
    });

    const relaxed = validate(catalogSchema, data, { unknownKeys: "ignore" });
    expect(relaxed.ok).toBe(true);
  });

  test("a type mismatch in a nested array element is reported with a concrete index", () => {
    const data = cloneValidData();
    (data.setlists[0]?.items[1] as { no: unknown }).no = "2";
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "SHAPE_MISMATCH",
      table: "setlists",
      pathString: "items[1].no",
      path: ["items", 1, "no"],
    });
  });

  test("detects a missing key two levels deep", () => {
    const data = cloneValidData();
    const track = data.videos[0]?.coveredEvents[1]?.tracks?.[0];
    if (track === undefined) throw new Error("the fixture is not what this test expects");
    Reflect.deleteProperty(track, "songId");
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      table: "videos",
      pathString: "coveredEvents[1].tracks[0].songId",
    });
  });

  test("detects a row that is not an object", () => {
    const data = cloneValidData();
    (data.artists as unknown[]).push("not-a-row");
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({ code: "SHAPE_MISMATCH", table: "artists", path: [] });
    expect(errors[0]?.rowLabel).toBe("(row 2)");
  });

  test("rowLabel uses displayAs and falls back on a broken row", () => {
    const data = cloneValidData();
    (data.songs[0] as { title: unknown }).title = 123;
    const errors = errorsOf(data);
    // displayAs embeds title, and 123 still stringifies, so it is used as-is
    expect(errors[0]?.rowLabel).toBe('"123" (s1)');

    (data.venues[1] as { name: unknown }).name = 5;
    const venueErrors = errorsOf(data).filter((e) => e.table === "venues");
    // venues has no displayAs, so it falls back to the PK
    expect(venueErrors[0]?.rowLabel).toBe("(id=v2)");
  });

  test("throws when a table's data is not an array", () => {
    const data = cloneValidData();
    expect(() => validate(catalogSchema, { ...data, artists: undefined as never })).toThrow(
      /data for table "artists" is not an array/,
    );
  });

  test("lists every error (it does not fail fast)", () => {
    const data = cloneValidData();
    (data.lives[0] as { year: unknown }).year = "2013";
    (data.songs[0] as { title: unknown }).title = null;
    (data.artists[0] as Record<string, unknown>).nickname = "x";
    expect(errorsOf(data)).toHaveLength(3);
  });
});

/**
 * How the checks a hand-written validation script would perform map onto this library.
 *
 * | Hand-written check                                    | steledb error code    | Test |
 * |-------------------------------------------------------|-----------------------|------|
 * | duplicate id in each table                             | DUPLICATE_KEY         | duplicate PK |
 * | duplicate slug in lives                                | DUPLICATE_KEY         | duplicate unique column |
 * | duplicate liveEventId in setlists (one setlist/event)  | DUPLICATE_KEY         | duplicate de facto PK |
 * | credited ids in songs exist in the master table        | FK_VIOLATION          | nested array FK |
 * | redundant credit name in songs matches the master      | DENORMALIZED_MISMATCH | strict mustMatch |
 * | liveId / venueId of events exist                       | FK_VIOLATION          | nullable scalar FK |
 * | events.venue matches venue.name or an alias            | DENORMALIZED_MISMATCH | alias-tolerant mustMatch |
 * | liveEventId of setlists exists in events               | FK_VIOLATION          | PK that is also an FK |
 * | setlists.items[].songId exists in songs                | FK_VIOLATION          | nested array FK |
 * | tracks[].songId of singles exists                      | FK_VIOLATION          | nested array FK |
 * | (disc, no) of singles is unique within a disc          | SCOPED_DUPLICATE      | uniqueBy |
 *
 * Checks such a script typically omits, which the schema covers for free: the three
 * families of FK in videos (coveredLiveIds[] / coveredEvents[].eventId /
 * coveredEvents[].tracks[].songId), shape validation, and custom checks.
 */
describe("validate: constraint checks", () => {
  test("detects a duplicate primary key", () => {
    const data = cloneValidData();
    data.artists.push({ id: "a1", name: "Duplicate Artist" });
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "DUPLICATE_KEY",
      table: "artists",
      rowIndex: 2,
      column: "id",
      value: "a1",
      otherRowIndex: 0,
    });
  });

  test("detects a duplicate in a unique column (lives.slug)", () => {
    const data = cloneValidData();
    const clone = structuredClone(data.lives[0]);
    if (clone === undefined) throw new Error("the fixture is empty");
    clone.id = "l99";
    const errors = errorsOf({ ...data, lives: [...data.lives, clone] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "DUPLICATE_KEY", column: "slug", value: "prism-2013" });
  });

  test("detects a duplicate de facto primary key (setlists.liveEventId)", () => {
    const data = cloneValidData();
    data.setlists.push({ liveEventId: "e1", items: [] });
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "DUPLICATE_KEY",
      table: "setlists",
      column: "liveEventId",
    });
  });

  test("detects a dangling nested array FK (songs.artists[].id)", () => {
    const data = cloneValidData();
    data.songs[0]?.artists.push({ id: "a999", name: "Missing Person" });
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "FK_VIOLATION",
      table: "songs",
      pathString: "artists[1].id",
      value: "a999",
      refTable: "artists",
      refColumn: "id",
    });
    expect(errors[0]?.rowLabel).toBe('"Deep Blue" (s1)');
  });

  test("detects a strict mustMatch mismatch (songs.artists[].name)", () => {
    const data = cloneValidData();
    const credit = data.songs[1]?.artists[0];
    if (credit) credit.name = "Aria";
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "DENORMALIZED_MISMATCH",
      table: "songs",
      pathString: "artists[0].name",
      actual: "Aria",
      expected: "Aria Vellon",
      refTable: "artists",
      refKeyPath: "artists[a1].name",
    });
    expect(errors[0]?.message).toContain("does not match");
  });

  test("detects dangling nullable scalar FKs (events.liveId / venueId)", () => {
    const data = cloneValidData();
    const event = data.events[0];
    if (event) {
      event.liveId = "l999";
      event.venueId = "v999";
      event.venue = null;
    }
    const errors = errorsOf(data);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.pathString).sort()).toEqual(["liveId", "venueId"]);
    expect(errors.every((e) => e.code === "FK_VIOLATION")).toBe(true);
  });

  test("alias-tolerant mustMatch (events.venue): an error only if it matches neither name nor alias", () => {
    const data = cloneValidData();
    const event = data.events[1];
    if (event) event.venue = "Unknown Arena";
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "DENORMALIZED_MISMATCH",
      table: "events",
      pathString: "venue",
      actual: "Unknown Arena",
      expected: "Grand Arena",
      allowedAliases: ["GA"],
    });
    expect(errors[0]?.message).toContain("is not contained in alias");
  });

  test("detects dangling setlists.items[].songId / singles.tracks[].songId", () => {
    const data = cloneValidData();
    const item = data.setlists[0]?.items[0];
    if (item) item.songId = "s999";
    const track = data.singles[0]?.tracks[1];
    if (track) track.songId = "s888";
    const errors = errorsOf(data);
    expect(errors).toHaveLength(2);
    expect(errors).toContainEqual(
      expect.objectContaining({ table: "setlists", pathString: "items[0].songId", value: "s999" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ table: "singles", pathString: "tracks[1].songId", value: "s888" }),
    );
  });

  test("detects a uniqueBy duplicate (the (disc ?? 1, no) of tracks)", () => {
    const data = cloneValidData();
    // no:1 without a disc (= 1) collides with no:1 on disc:1
    data.singles[0]?.tracks.push({ no: 1, disc: 1, songId: "s2", title: "Duplicate Track" });
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "SCOPED_DUPLICATE",
      table: "singles",
      pathString: "tracks[2]",
      scopePath: "tracks",
      key: [1, 1],
    });
  });

  test("detects the three families of FK in videos", () => {
    const data = cloneValidData();
    const video = data.videos[0];
    if (video === undefined) throw new Error("the fixture is empty");
    video.coveredLiveIds.push("l999");
    video.coveredEvents.push({ eventId: "e999" });
    video.coveredEvents[1]?.tracks?.push({ songId: "s999", title: "?" });
    const errors = errorsOf(data);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.pathString).sort()).toEqual([
      "coveredEvents[1].tracks[1].songId",
      "coveredEvents[2].eventId",
      "coveredLiveIds[1]",
    ]);
  });

  test("detects a custom check failure (the date consistency of lives)", () => {
    const data = cloneValidData();
    const live = data.lives[0];
    if (live) live.endDate = "2012-12-31";
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "CHECK_FAILED",
      table: "lives",
      detail: "endDate is earlier than startDate",
    });
  });

  test("rows with a broken shape skip the relational checks (to cut down the noise)", () => {
    const data = cloneValidData();
    const event = data.events[0] as Record<string, unknown>;
    event.liveId = 123; // wrong type: a shape error, so the FK check is skipped
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("SHAPE_MISMATCH");
  });
});
