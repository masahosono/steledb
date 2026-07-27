import { describe, expect, test } from "vitest";
import { t } from "./column.js";
import { createDb, createValidatedDb } from "./db.js";
import { defineSchema } from "./schema.js";
import { table } from "./table.js";
import { catalogSchema, cloneValidData, validData } from "./testing/catalog-schema.js";

const db = createDb(catalogSchema, validData);

describe("Db: basic queries", () => {
  test("get does an O(1) lookup by primary key", () => {
    expect(db.get(catalogSchema.songs, "s1")?.title).toBe("Deep Blue");
    expect(db.get(catalogSchema.songs, "s999")).toBeUndefined();
    // liveEventId is the de facto primary key of setlists
    expect(db.get(catalogSchema.setlists, "e1")?.items).toHaveLength(3);
  });

  test("getOrThrow throws with a specific message when nothing matches", () => {
    expect(db.getOrThrow(catalogSchema.artists, "a1").name).toBe("Aria Vellon");
    expect(() => db.getOrThrow(catalogSchema.artists, "a999")).toThrow(
      /no row with id="a999" in artists/,
    );
  });

  test("get takes a tuple for a composite primary key", () => {
    expect(db.get(catalogSchema.songRankings, ["s1", 2013])?.rank).toBe(1);
    expect(db.get(catalogSchema.songRankings, ["s1", 2015])?.rank).toBe(2);
    // The order of the tuple is the declared one, so a swapped pair matches nothing
    expect(db.get(catalogSchema.songRankings, ["s1", 2099])).toBeUndefined();
  });

  test("getOrThrow names every column of a composite key", () => {
    expect(() => db.getOrThrow(catalogSchema.songRankings, ["s9", 2013])).toThrow(
      /no row with songId, year=\["s9",2013\] in songRankings/,
    );
  });

  test("a composite key given as anything but a matching tuple throws", () => {
    expect(() => db.get(catalogSchema.songRankings, "s1" as never)).toThrow(
      /composite primary key \(songId, year\), so get takes an array of 2 values/,
    );
    expect(() => db.get(catalogSchema.songRankings, ["s1"] as never)).toThrow(/array of 2 values/);
  });

  test("getBy looks up by a unique column", () => {
    expect(db.getBy(catalogSchema.lives.slug, "prism-2013")?.name).toBe("LIVE PRISM 2013");
    expect(db.getBy(catalogSchema.videos.slug, "clips-1")?.title).toBe("CLIP COLLECTION 1");
    expect(db.getBy(catalogSchema.lives.slug, "nothing")).toBeUndefined();
  });

  test("getBy rejects a non-unique column at runtime too", () => {
    expect(() => db.getBy(catalogSchema.songs.title as never, "Deep Blue")).toThrow(
      /songs\.title is not unique/,
    );
  });

  test("all applies defaultOrder (events sort by eventDate descending)", () => {
    const events = db.all(catalogSchema.events);
    expect(events.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
  });

  test("all honours nulls: last (songs sort by releaseDate descending, nulls last)", () => {
    const songs = db.all(catalogSchema.songs);
    expect(songs.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  test("without defaultOrder all keeps insertion order, and the result is cached", () => {
    const artists = db.all(catalogSchema.artists);
    expect(artists.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(db.all(catalogSchema.artists)).toBe(artists);
    expect(db.all(catalogSchema.events)).toBe(db.all(catalogSchema.events));
  });

  test("rowsOf returns the raw rows in insertion order", () => {
    expect(db.rowsOf(catalogSchema.events).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("count", () => {
    expect(db.count(catalogSchema.songs)).toBe(3);
  });

  test("a table outside the schema throws", () => {
    const outsider = table("outsider", { id: t.string().primaryKey() });
    expect(() => db.get(outsider, "x")).toThrow(/is not part of this database's schema/);
  });

  test("get on a table without a primary key throws", () => {
    const noPk = table("noPk", { name: t.string() });
    const schema = defineSchema({ noPk });
    const smallDb = createDb(schema, { noPk: [{ name: "x" }] });
    expect(() => smallDb.get(schema.noPk, "x" as never)).toThrow(/has no primaryKey/);
  });

  test("a missing data key throws", () => {
    expect(() => createDb(catalogSchema, { ...validData, songs: undefined as never })).toThrow(
      /data for table "songs" is not an array/,
    );
  });
});

describe("createValidatedDb", () => {
  test("valid data yields a Db as usual", () => {
    const validated = createValidatedDb(catalogSchema, validData);
    expect(validated.count(catalogSchema.songs)).toBe(3);
  });

  test("validation errors throw with the output of formatErrors", () => {
    const data = cloneValidData();
    data.songs[0]?.artists.push({ id: "a999", name: "Missing Person" });
    expect(() => createValidatedDb(catalogSchema, data)).toThrow(/1 integrity error/);
    expect(() => createValidatedDb(catalogSchema, data)).toThrow(/artists\[1\]\.id/);
  });
});
