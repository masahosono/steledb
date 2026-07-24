import { expectTypeOf, test } from "vitest";
import { createDb } from "./db.js";
import { eq, gt, some } from "./expr.js";
import { catalogSchema as s, validData } from "./testing/catalog-schema.js";

const db = createDb(s, validData);

test("射影なしの from は行型の配列を返す", () => {
  const rows = db.select().from(s.songs).all();
  expectTypeOf(rows[0]?.title).toEqualTypeOf<string | undefined>();
  expectTypeOf(rows[0]?.releaseDate).toEqualTypeOf<string | null | undefined>();
});

test("射影から戻り値型が推論される（カラム参照 + テーブル丸ごとの混在）", () => {
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
        yomi: string | null;
        releaseDate: string | null;
        artists: { id: string; name: string }[];
      };
    }[]
  >();
});

test("eq はカラムの値型を要求する（enum への不正リテラルはエラー）", () => {
  eq(s.events.kind, "festival");
  // @ts-expect-error enum に無いリテラルはコンパイルエラー
  eq(s.events.kind, "secret_live");
  // @ts-expect-error string カラムに number は渡せない
  eq(s.songs.title, 123);
  gt(s.songs.releaseDate, "2010-01-01");
});

test("some の要素アクセサは要素型に沿って型付けされる", () => {
  some(s.songs.artists, (artist) => {
    expectTypeOf(artist.id).toExtend<{ readonly "~data"?: string }>();
    // @ts-expect-error 要素に無いフィールドはエラー
    artist.nope;
    return eq(artist.id, "a1");
  });

  some(s.videos.coveredEvents, (coverage) =>
    some(coverage.tracks, (track) => eq(track.songId, "s1")),
  );
});

test("first は TRow | undefined、firstOrThrow は TRow", () => {
  const first = db.select({ id: s.songs.id }).from(s.songs).first();
  expectTypeOf(first).toEqualTypeOf<{ id: string } | undefined>();
  const sure = db.select({ id: s.songs.id }).from(s.songs).firstOrThrow();
  expectTypeOf(sure).toEqualTypeOf<{ id: string }>();
});

test("countBy はキー型の Map を返す", () => {
  const counts = db
    .select({ kind: s.events.kind })
    .from(s.events)
    .countBy((row) => row.kind);
  expectTypeOf(counts).toEqualTypeOf<
    Map<"official_live" | "official_event" | "festival", number>
  >();
});
