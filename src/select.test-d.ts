import { expectTypeOf, test } from "vitest";
import { createDb } from "./db.js";
import { eq, gt, some } from "./expr.js";
import { catalogSchema as s, validData } from "./testing/catalog-schema.js";

const db = createDb(s, validData);

test("from without a projection returns an array of the row type", () => {
  const rows = db.select().from(s.songs).all();
  expectTypeOf(rows[0]?.title).toEqualTypeOf<string | undefined>();
  expectTypeOf(rows[0]?.releaseDate).toEqualTypeOf<string | null | undefined>();
});

test("the return type is inferred from the projection (column references mixed with whole tables)", () => {
  const rows = db
    .select({ id: s.songs.id, releaseDate: s.songs.releaseDate, song: s.songs })
    .from(s.songs)
    .all();
  expectTypeOf(rows).toEqualTypeOf<
    {
      id: string;
      releaseDate: string | null;
      song: {
        id: string;
        title: string;
        sortTitle: string | null;
        releaseDate: string | null;
        artists: { id: string; name: string }[];
      };
    }[]
  >();
});

test("eq demands the column's value type (an invalid enum literal is an error)", () => {
  eq(s.events.kind, "festival");
  // @ts-expect-error a literal outside the enum is a compile error
  eq(s.events.kind, "secret_live");
  // @ts-expect-error a number cannot be passed to a string column
  eq(s.songs.title, 123);
  gt(s.songs.releaseDate, "2010-01-01");
});

test("the element accessor of some is typed after the element type", () => {
  some(s.songs.artists, (artist) => {
    expectTypeOf(artist.id).toExtend<{ readonly "~data"?: string }>();
    // @ts-expect-error a field the element does not have is an error
    artist.nope;
    return eq(artist.id, "a1");
  });

  some(s.videos.coveredEvents, (coverage) =>
    some(coverage.tracks, (track) => eq(track.songId, "s1")),
  );
});

test("first is TRow | undefined and firstOrThrow is TRow", () => {
  const first = db.select({ id: s.songs.id }).from(s.songs).first();
  expectTypeOf(first).toEqualTypeOf<{ id: string } | undefined>();
  const sure = db.select({ id: s.songs.id }).from(s.songs).firstOrThrow();
  expectTypeOf(sure).toEqualTypeOf<{ id: string }>();
});

test("countBy returns a Map keyed by the key type", () => {
  const counts = db
    .select({ kind: s.events.kind })
    .from(s.events)
    .countBy((row) => row.kind);
  expectTypeOf(counts).toEqualTypeOf<
    Map<"official_live" | "official_event" | "festival", number>
  >();
});
