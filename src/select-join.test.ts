import { describe, expect, test } from "vitest";
import { createDb } from "./db.js";
import { and, arrayContains, eq, some } from "./expr.js";
import { unnest } from "./select.js";
import { catalogSchema as s, validData } from "./testing/catalog-schema.js";

const db = createDb(s, validData);

describe("unnest", () => {
  test("expands an array column into one row per element", () => {
    const item = unnest(s.setlists.items);
    const rows = db.select().from(item).all();
    expect(rows).toHaveLength(4); // three songs for e1 plus one for e2
    expect(rows[0]).toEqual({ no: 1, songId: "s2", name: "SILVER TIDE" });
  });

  test("$parent / $index / $ are available", () => {
    const item = unnest(s.setlists.items);
    const rows = db
      .select({ eventId: item.$parent.liveEventId, index: item.$index, element: item.$ })
      .from(item)
      .where(eq(item.songId, "s1"))
      .all();
    expect(rows).toEqual([
      { eventId: "e1", index: 1, element: { no: 2, songId: "s1", name: "Deep Blue" } },
      { eventId: "e2", index: 0, element: { no: 1, songId: "s1", name: "Deep Blue" } },
    ]);
  });

  test("putting the parent table in the projection yields the whole parent row", () => {
    const item = unnest(s.setlists.items);
    const rows = db
      .select({ setlist: s.setlists, songId: item.songId })
      .from(item)
      .where(eq(item.$parent.liveEventId, "e2"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.setlist).toBe(validData.setlists[1]);
  });

  test("unnest on anything but an array column throws", () => {
    expect(() => unnest(s.songs.title as never)).toThrow(/only be used on array columns/);
  });
});

describe("join", () => {
  test("an innerJoin without a projection returns a table-name-keyed result", () => {
    const rows = db
      .select()
      .from(s.events)
      .innerJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .all();
    // e3 drops out because its liveId is null. The defaultOrder (eventDate descending) still applies
    expect(rows.map((r) => r.events.id)).toEqual(["e2", "e1"]);
    expect(rows[0]?.lives.name).toBe("LIVE PRISM 2013");
  });

  test("a leftJoin without a projection keeps unmatched rows with null", () => {
    const rows = db
      .select()
      .from(s.events)
      .leftJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .all();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.events.id).toBe("e3");
    expect(rows[0]?.lives).toBeNull();
    expect(rows[1]?.lives?.id).toBe("l1");
  });

  test("with a projection, a leftJoin can make a whole-table entry null", () => {
    const rows = db
      .select({ id: s.events.id, live: s.lives })
      .from(s.events)
      .leftJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .all();
    expect(rows.find((r) => r.id === "e3")?.live).toBeNull();
    expect(rows.find((r) => r.id === "e1")?.live?.slug).toBe("prism-2013");
  });

  test("an on condition other than eq falls back to a nested loop and still works", () => {
    const rows = db
      .select()
      .from(s.events)
      .innerJoin(s.lives, and(eq(s.events.liveId, s.lives.id), eq(s.lives.year, 2013)))
      .all();
    expect(rows).toHaveLength(2);
  });

  test("an unnest source joined without a projection throws a specific message", () => {
    const item = unnest(s.setlists.items);
    expect(() =>
      db.select().from(item).innerJoin(s.songs, eq(item.songId, s.songs.id)).all(),
    ).toThrow(/requires an explicit projection/);
  });
});

describe("four real-world query shapes", () => {
  // (1) A multi-step join: song -> setlists(items) -> events -> lives
  test("finds the events and tours where a given song was played", () => {
    const item = unnest(s.setlists.items);
    const rows = db
      .select({ live: s.lives, event: s.events })
      .from(item)
      .where(eq(item.songId, "s1"))
      .innerJoin(s.events, eq(item.$parent.liveEventId, s.events.id))
      .innerJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.event.id).sort()).toEqual(["e1", "e2"]);
    expect(rows.every((r) => r.live.id === "l1")).toBe(true);

    const uniqueLives = db
      .select({ live: s.lives, event: s.events })
      .from(item)
      .where(eq(item.songId, "s1"))
      .innerJoin(s.events, eq(item.$parent.liveEventId, s.events.id))
      .innerJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .distinctBy((r) => r.live.id)
      .all();
    expect(uniqueLives).toHaveLength(1);
  });

  // (2) A reverse lookup: songs whose artists[] contains a given id
  test("looks up songs from an artist", () => {
    const rows = db
      .select()
      .from(s.songs)
      .where(some(s.songs.artists, (artist) => eq(artist.id, "a1")))
      .all();
    // defaultOrder: releaseDate descending
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  // (3) A reverse lookup through a scalar array FK: videos whose coveredLiveIds contains a liveId
  test("looks up videos from a tour", () => {
    const rows = db
      .select()
      .from(s.videos)
      .where(arrayContains(s.videos.coveredLiveIds, "l1"))
      .all();
    expect(rows.map((r) => r.id)).toEqual(["vd1"]);
  });

  // (4) An aggregation: how many events played each song (repeats within one event count once)
  test("counts the events at which each song was played", () => {
    const item = unnest(s.setlists.items);
    const counts = db
      .select({ songId: item.songId, eventId: item.$parent.liveEventId })
      .from(item)
      .distinctBy((row) => `${row.songId}:${row.eventId}`)
      .countBy((row) => row.songId);
    expect(counts.get("s1")).toBe(2); // e1 and e2
    expect(counts.get("s2")).toBe(1); // e1 (the main set plus the encore count as one event)
  });
});
