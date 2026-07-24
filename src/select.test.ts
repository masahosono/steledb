import { describe, expect, test } from "vitest";
import { createDb } from "./db.js";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  some,
} from "./expr.js";
import { catalogSchema as s, validData } from "./testing/catalog-schema.js";

const db = createDb(s, validData);

describe("select: 単一テーブル", () => {
  test("射影なしは行そのものを返す", () => {
    const rows = db.select().from(s.artists).all();
    expect(rows).toEqual(validData.artists);
  });

  test("射影（カラム参照）から戻り値の形が決まる", () => {
    const rows = db
      .select({ id: s.songs.id, title: s.songs.title })
      .from(s.songs)
      .orderBy(asc(s.songs.id))
      .all();
    expect(rows).toEqual([
      { id: "s1", title: "Deep Blue" },
      { id: "s2", title: "SILVER TIDE" },
      { id: "s3", title: "未発表曲" },
    ]);
  });

  test("射影にテーブルを置くと行を丸ごと入れる", () => {
    const rows = db
      .select({ song: s.songs, title: s.songs.title })
      .from(s.songs)
      .where(eq(s.songs.id, "s1"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.song).toBe(validData.songs[0]);
    expect(rows[0]?.title).toBe("Deep Blue");
  });

  test("where: eq / ne / gt / inArray / isNull / isNotNull / and / or / not", () => {
    const byEq = db.select().from(s.events).where(eq(s.events.kind, "festival")).all();
    expect(byEq.map((e) => e.id)).toEqual(["e3"]);

    const byNe = db.select().from(s.events).where(ne(s.events.status, "cancelled")).all();
    expect(byNe).toHaveLength(2);

    const byGt = db.select().from(s.events).where(gt(s.events.eventDate, "2013-01-05")).all();
    expect(byGt.map((e) => e.id)).toEqual(["e3", "e2"]);

    const byIn = db
      .select()
      .from(s.songs)
      .where(inArray(s.songs.id, ["s1", "s3"]))
      .all();
    expect(byIn.map((r) => r.id).sort()).toEqual(["s1", "s3"]);

    const byNull = db.select().from(s.events).where(isNull(s.events.liveId)).all();
    expect(byNull.map((e) => e.id)).toEqual(["e3"]);

    const byNotNull = db.select().from(s.songs).where(isNotNull(s.songs.releaseDate)).all();
    expect(byNotNull).toHaveLength(2);

    const byAnd = db
      .select()
      .from(s.events)
      .where(and(eq(s.events.kind, "official_live"), eq(s.events.eventDate, "2013-01-06")))
      .all();
    expect(byAnd.map((e) => e.id)).toEqual(["e2"]);

    const byOr = db
      .select()
      .from(s.events)
      .where(or(eq(s.events.id, "e1"), eq(s.events.id, "e3")))
      .all();
    expect(byOr).toHaveLength(2);

    const byNot = db
      .select()
      .from(s.events)
      .where(not(eq(s.events.status, "confirmed")))
      .all();
    expect(byNot.map((e) => e.id)).toEqual(["e3"]);
  });

  test("where を複数回呼ぶと AND になる", () => {
    const rows = db
      .select()
      .from(s.events)
      .where(eq(s.events.kind, "official_live"))
      .where(eq(s.events.eventDate, "2013-01-05"))
      .all();
    expect(rows.map((e) => e.id)).toEqual(["e1"]);
  });

  test("orderBy が無ければ defaultOrder（events は eventDate 降順）", () => {
    const rows = db.select().from(s.events).all();
    expect(rows.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
  });

  test("明示 orderBy は defaultOrder を上書きし、nulls 指定も効く", () => {
    const rows = db.select().from(s.events).orderBy(asc(s.events.eventDate)).all();
    expect(rows.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);

    const nullsFirst = db
      .select()
      .from(s.songs)
      .orderBy(desc(s.songs.releaseDate, { nulls: "first" }))
      .all();
    expect(nullsFirst.map((r) => r.id)).toEqual(["s3", "s1", "s2"]);
  });

  test("orderBy に式を直接渡すと暗黙 asc になる", () => {
    const rows = db.select().from(s.songs).orderBy(s.songs.title).all();
    expect(rows.map((r) => r.title)).toEqual(["SILVER TIDE", "未発表曲", "Deep Blue"]);
  });

  test("limit / first / firstOrThrow / count", () => {
    expect(db.select().from(s.events).limit(2).all()).toHaveLength(2);
    expect(db.select().from(s.events).first()?.id).toBe("e3");
    expect(db.select().from(s.events).where(eq(s.events.id, "nope")).first()).toBeUndefined();
    expect(() => db.select().from(s.events).where(eq(s.events.id, "nope")).firstOrThrow()).toThrow(
      /0 件/,
    );
    expect(db.select().from(s.events).where(isNotNull(s.events.liveId)).count()).toBe(2);
  });

  test("some: ネスト配列の逆参照（artists[].id に一致する songs）", () => {
    const rows = db
      .select()
      .from(s.songs)
      .where(some(s.songs.artists, (artist) => eq(artist.id, "a2")))
      .all();
    expect(rows.map((r) => r.id)).toEqual(["s2"]);
  });

  test("some のネスト: 2 重ネスト配列（coveredEvents[].tracks[].songId）", () => {
    const rows = db
      .select()
      .from(s.videos)
      .where(
        some(s.videos.coveredEvents, (coverage) =>
          some(coverage.tracks, (track) => eq(track.songId, "s1")),
        ),
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual(["vd1"]);
  });

  test("arrayContains: スカラー配列 FK の逆参照", () => {
    const rows = db
      .select()
      .from(s.videos)
      .where(arrayContains(s.videos.coveredLiveIds, "l1"))
      .all();
    expect(rows.map((r) => r.id)).toEqual(["vd1"]);
  });

  test("distinctBy は射影後の行に効く", () => {
    const rows = db
      .select({ kind: s.events.kind })
      .from(s.events)
      .distinctBy((row) => row.kind)
      .all();
    expect(rows.map((r) => r.kind).sort()).toEqual(["festival", "official_live"]);
  });

  test("countBy は射影後の行からキー別件数を返す", () => {
    const counts = db
      .select({ kind: s.events.kind })
      .from(s.events)
      .countBy((row) => row.kind);
    expect(counts.get("official_live")).toBe(2);
    expect(counts.get("festival")).toBe(1);
  });

  test("ソースに無いテーブルのカラムを where に使うと実行時エラー", () => {
    expect(() => db.select().from(s.songs).where(eq(s.events.id, "e1")).all()).toThrow(
      /テーブル "events" のカラム "id" はこのクエリのソースに含まれていません/,
    );
  });

  test("ソースに無いテーブルを射影に置くと実行時エラー", () => {
    expect(() => db.select({ event: s.events }).from(s.songs).all()).toThrow(
      /射影のテーブル "events" はこのクエリのソースに含まれていません/,
    );
  });
});
