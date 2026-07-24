import { describe, expect, test } from "vitest";
import { createDb } from "./db.js";
import { and, arrayContains, eq, some } from "./expr.js";
import { unnest } from "./select.js";
import { catalogSchema as s, validData } from "./testing/catalog-schema.js";

const db = createDb(s, validData);

describe("unnest", () => {
  test("配列カラムを 1 要素 = 1 行に展開する", () => {
    const item = unnest(s.setlists.items);
    const rows = db.select().from(item).all();
    expect(rows).toHaveLength(4); // e1 に 3 曲 + e2 に 1 曲
    expect(rows[0]).toEqual({ no: 1, songId: "s2", name: "SILVER TIDE" });
  });

  test("$parent / $index / $ が使える", () => {
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

  test("親テーブルを射影に置くと親行を丸ごと取れる", () => {
    const item = unnest(s.setlists.items);
    const rows = db
      .select({ setlist: s.setlists, songId: item.songId })
      .from(item)
      .where(eq(item.$parent.liveEventId, "e2"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.setlist).toBe(validData.setlists[1]);
  });

  test("配列カラム以外の unnest は throw", () => {
    expect(() => unnest(s.songs.title as never)).toThrow(/配列カラムにのみ/);
  });
});

describe("join", () => {
  test("射影なしの innerJoin はテーブル名キーの結果を返す", () => {
    const rows = db
      .select()
      .from(s.events)
      .innerJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .all();
    // e3 は liveId null なので落ちる。defaultOrder (eventDate 降順) が効く
    expect(rows.map((r) => r.events.id)).toEqual(["e2", "e1"]);
    expect(rows[0]?.lives.name).toBe("LIVE PRISM 2013");
  });

  test("射影なしの leftJoin はミスマッチ行を null で残す", () => {
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

  test("射影ありの leftJoin はテーブル丸ごとエントリが null になりうる", () => {
    const rows = db
      .select({ id: s.events.id, live: s.lives })
      .from(s.events)
      .leftJoin(s.lives, eq(s.events.liveId, s.lives.id))
      .all();
    expect(rows.find((r) => r.id === "e3")?.live).toBeNull();
    expect(rows.find((r) => r.id === "e1")?.live?.slug).toBe("prism-2013");
  });

  test("eq 以外の on 条件はネストループにフォールバックして動く", () => {
    const rows = db
      .select()
      .from(s.events)
      .innerJoin(s.lives, and(eq(s.events.liveId, s.lives.id), eq(s.lives.year, 2013)))
      .all();
    expect(rows).toHaveLength(2);
  });

  test("unnest ソース + 射影なしの join は具体的なメッセージで throw", () => {
    const item = unnest(s.setlists.items);
    expect(() =>
      db.select().from(item).innerJoin(s.songs, eq(item.songId, s.songs.id)).all(),
    ).toThrow(/射影（select\({...}\)）を指定してください/);
  });
});

describe("実クエリ 4 パターン", () => {
  // (1) 多段 join: song → setlists(items) → events → lives
  test("ある曲が歌われた公演とライブを引く", () => {
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

  // (2) 逆参照: artists[] に特定 id を含む songs
  test("アーティストから曲を逆引きする", () => {
    const rows = db
      .select()
      .from(s.songs)
      .where(some(s.songs.artists, (artist) => eq(artist.id, "a1")))
      .all();
    // defaultOrder: releaseDate 降順
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  // (3) スカラー配列 FK の逆参照: coveredLiveIds に liveId を含む videos
  test("ライブから映像作品を逆引きする", () => {
    const rows = db
      .select()
      .from(s.videos)
      .where(arrayContains(s.videos.coveredLiveIds, "l1"))
      .all();
    expect(rows.map((r) => r.id)).toEqual(["vd1"]);
  });

  // (4) 集計: 曲ごとの公演回数（同一公演内の複数歌唱は 1 と数える）
  test("曲ごとの歌唱公演数を数える", () => {
    const item = unnest(s.setlists.items);
    const counts = db
      .select({ songId: item.songId, eventId: item.$parent.liveEventId })
      .from(item)
      .distinctBy((row) => `${row.songId}:${row.eventId}`)
      .countBy((row) => row.songId);
    expect(counts.get("s1")).toBe(2); // e1, e2
    expect(counts.get("s2")).toBe(1); // e1（本編 + EN は 1 公演と数える）
  });
});
