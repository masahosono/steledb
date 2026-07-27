import { describe, expect, test } from "vitest";
import { catalogSchema, validData } from "../testing/catalog-schema.js";
import { buildStudioMeta } from "./meta.js";
import { ReferenceIndex, pkValueOf, rowLabelOf } from "./refs.js";

const meta = buildStudioMeta(catalogSchema, {
  readOnly: false,
  fileFor: (tableKey) => `${tableKey}.json`,
});
const refs = new ReferenceIndex(catalogSchema, meta, validData);

function tableOf(key: string) {
  const table = meta.tables.find((candidate) => candidate.key === key);
  if (table === undefined) throw new Error(`no table meta for "${key}"`);
  return table;
}

describe("resolve", () => {
  test("finds the row a foreign key value points at", () => {
    const firstArtist = validData.artists[0];
    expect(firstArtist).toBeDefined();
    expect(refs.resolve("artists", "id", firstArtist?.id)).toBe(0);
  });

  test("returns undefined for a value nothing matches", () => {
    expect(refs.resolve("artists", "id", "does-not-exist")).toBeUndefined();
  });

  test("resolveRef carries the label used for the link text", () => {
    const song = validData.songs[0];
    const resolved = refs.resolveRef("songs", "id", song?.id);
    expect(resolved).toMatchObject({ table: "songs", rowIndex: 0, pkValue: song?.id });
    // songs declares displayAs, so the label comes from there
    expect(resolved?.rowLabel).toBe(`"${song?.title}" (${song?.id})`);
  });

  test("resolves against a unique column that is not the primary key", () => {
    const video = validData.videos[0];
    expect(refs.resolve("videos", "slug", video?.slug)).toBe(0);
  });
});

describe("backlinksOf", () => {
  test("finds rows pointing at a value through a nested array path", () => {
    // setlists.items[].songId points at songs.id
    const songId = validData.setlists[0]?.items[0]?.songId;
    expect(songId).toBeDefined();
    const found = refs.backlinksOf("songs", "id", songId);
    const fromSetlists = found.filter((ref) => ref.table === "setlists");
    expect(fromSetlists.length).toBeGreaterThan(0);
    expect(fromSetlists[0]?.pathString).toMatch(/^items\[\d+\]\.songId$/);
  });

  test("reports the concrete path, with array indexes filled in", () => {
    const single = validData.singles[0];
    const secondTrack = single?.tracks[1];
    expect(secondTrack).toBeDefined();
    const found = refs
      .backlinksOf("songs", "id", secondTrack?.songId)
      .filter((ref) => ref.table === "singles" && ref.rowIndex === 0);
    expect(found.map((ref) => ref.pathString)).toContain("tracks[1].songId");
  });

  test("covers doubly nested paths", () => {
    const songId = validData.videos
      .flatMap((video) => video.coveredEvents)
      .flatMap((event) => event.tracks ?? [])
      .at(0)?.songId;
    expect(songId).toBeDefined();
    const found = refs.backlinksOf("songs", "id", songId);
    expect(
      found.some((ref) => /^coveredEvents\[\d+\]\.tracks\[\d+\]\.songId$/.test(ref.pathString)),
    ).toBe(true);
  });

  test("covers a scalar array of foreign keys", () => {
    const liveId = validData.videos.flatMap((video) => video.coveredLiveIds).at(0);
    expect(liveId).toBeDefined();
    const found = refs.backlinksOf("lives", "id", liveId);
    expect(
      found.some((ref) => ref.table === "videos" && /^coveredLiveIds\[\d+\]$/.test(ref.pathString)),
    ).toBe(true);
  });

  test("is empty for a value nothing references", () => {
    expect(refs.backlinksOf("songs", "id", "no-such-song")).toEqual([]);
    // announcements are referenced by nobody at all
    const announcement = validData.announcements[0];
    expect(refs.backlinksOf("announcements", "id", announcement?.id)).toEqual([]);
  });

  test("backlinkCountOf totals every incoming reference for a row", () => {
    const song = validData.songs[0];
    const total = refs.backlinkCountOf("songs", song);
    expect(total).toBe(refs.backlinksOf("songs", "id", song?.id).length);
    expect(total).toBeGreaterThan(0);
  });
});

describe("rowLabelOf", () => {
  test("prefers the table's displayAs", () => {
    const event = validData.events[0];
    expect(rowLabelOf(catalogSchema, tableOf("events"), event, 0)).toBe(
      `"${event?.name ?? event?.id}" (${event?.id})`,
    );
  });

  test("falls back to a label column when there is no displayAs", () => {
    const artist = validData.artists[0];
    expect(rowLabelOf(catalogSchema, tableOf("artists"), artist, 0)).toBe(artist?.name);
  });

  test("falls back to the primary key, then to the row index", () => {
    const table = tableOf("artists");
    expect(rowLabelOf(catalogSchema, table, { id: "a9", name: "" }, 3)).toBe("a9");
    expect(rowLabelOf(catalogSchema, table, {}, 3)).toBe("row 3");
    expect(rowLabelOf(catalogSchema, table, null, 7)).toBe("row 7");
  });

  test("survives a displayAs that throws on a broken row", () => {
    // events' displayAs dereferences row.name, which throws for a null row
    expect(rowLabelOf(catalogSchema, tableOf("events"), null, 5)).toBe("row 5");
  });
});

describe("pkValueOf", () => {
  test("reads the primary key when there is one", () => {
    expect(pkValueOf(tableOf("artists"), { id: "a1", name: "x" })).toBe("a1");
    expect(pkValueOf(tableOf("artists"), { name: "x" })).toBeNull();
    expect(pkValueOf(tableOf("artists"), null)).toBeNull();
  });
});
