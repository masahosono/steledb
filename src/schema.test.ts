import { describe, expect, test } from "vitest";
import { t } from "./column.js";
import { constraintsOf, defineSchema, formatPath } from "./schema.js";
import { table } from "./table.js";
import { catalogSchema } from "./testing/catalog-schema.js";

describe("defineSchema: キッチンシンクの解決", () => {
  test("実データ相当スキーマが凍結に通る", () => {
    expect(catalogSchema._.tables.size).toBe(9);
    expect(catalogSchema.songs._.name).toBe("songs");
  });

  test("PK / unique が解決される（uniques は PK を含む）", () => {
    const lives = constraintsOf(catalogSchema, "lives");
    expect(lives.pk).toBe("id");
    expect(lives.uniques).toEqual(["id", "slug"]);
    const setlists = constraintsOf(catalogSchema, "setlists");
    expect(setlists.pk).toBe("liveEventId");
  });

  test("ネスト配列 FK / 2 重ネスト FK / スカラー配列 FK のパスが解決される", () => {
    const songs = constraintsOf(catalogSchema, "songs");
    expect(songs.references).toContainEqual({
      path: ["artists", "[]", "id"],
      target: { tableKey: "artists", columnKey: "id" },
    });

    const videos = constraintsOf(catalogSchema, "videos");
    const paths = videos.references.map((r) => formatPath(r.path));
    expect(paths).toContain("coveredLiveIds[]");
    expect(paths).toContain("coveredEvents[].eventId");
    expect(paths).toContain("coveredEvents[].tracks[].songId");
  });

  test("mustMatch が viaTarget / target / orIn に解決される", () => {
    const events = constraintsOf(catalogSchema, "events");
    expect(events.mustMatches).toEqual([
      {
        path: ["venue"],
        via: "venueId",
        viaTarget: { tableKey: "venues", columnKey: "id" },
        target: { tableKey: "venues", columnKey: "name" },
        orIn: { tableKey: "venues", columnKey: "alias" },
      },
    ]);

    const songs = constraintsOf(catalogSchema, "songs");
    expect(songs.mustMatches).toEqual([
      {
        path: ["artists", "[]", "name"],
        via: "id",
        viaTarget: { tableKey: "artists", columnKey: "id" },
        target: { tableKey: "artists", columnKey: "name" },
      },
    ]);
  });

  test("uniqueBy が配列パスに解決される", () => {
    const singles = constraintsOf(catalogSchema, "singles");
    expect(singles.uniqueBys).toHaveLength(1);
    expect(formatPath(singles.uniqueBys[0]?.path ?? [])).toBe("tracks");
  });

  test("参照を持たないテーブルは空の制約になる", () => {
    const announcements = constraintsOf(catalogSchema, "announcements");
    expect(announcements.references).toEqual([]);
    expect(announcements.mustMatches).toEqual([]);
  });
});

describe("defineSchema: 不正スキーマの検出", () => {
  test("スキーマ外テーブルへの thunk 参照は throw", () => {
    const outside = table("outside", { id: t.string().primaryKey() });
    const a = table("a", {
      id: t.string().primaryKey(),
      ref: t.string().references(() => outside.id),
    });
    expect(() => defineSchema({ a })).toThrow(/スキーマに登録されていません/);
  });

  test("文字列形式の参照先タイポは登録済みテーブル一覧つきで throw", () => {
    const a = table("a", { id: t.string().primaryKey(), ref: t.string().references("bbb", "id") });
    const b = table("b", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a, b })).toThrow(
      /参照先テーブル "bbb" がスキーマに存在しません.*登録済み: a, b/,
    );
  });

  test("文字列形式の参照先カラムが無ければ throw", () => {
    const a = table("a", { id: t.string().primaryKey(), ref: t.string().references("b", "slug") });
    const b = table("b", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a, b })).toThrow(/参照先カラム "b.slug" が存在しません/);
  });

  test("unique でないカラムへの FK は throw", () => {
    const b = table("b", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", { id: t.string().primaryKey(), ref: t.string().references(() => b.name) });
    expect(() => defineSchema({ a, b })).toThrow(/unique がありません/);
  });

  test("primaryKey が複数あると throw", () => {
    const a = table("a", { id: t.string().primaryKey(), slug: t.string().primaryKey() });
    expect(() => defineSchema({ a })).toThrow(/primaryKey が複数/);
  });

  test("ネストカラムの unique / primaryKey は throw", () => {
    const a = table("a", {
      id: t.string().primaryKey(),
      items: t.array(t.object({ code: t.string().unique() })),
    });
    expect(() => defineSchema({ a })).toThrow(/トップレベルカラムにのみ/);
  });

  test("mustMatch の via が同一スコープに無ければ throw", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      name: t.string().mustMatch(() => m.name, { via: "mId" }),
    });
    expect(() => defineSchema({ a, m })).toThrow(/via "mId" が同一スコープに存在しません/);
  });

  test("mustMatch の via に references が無ければ throw", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      mId: t.string(),
      name: t.string().mustMatch(() => m.name, { via: "mId" }),
    });
    expect(() => defineSchema({ a, m })).toThrow(/via "mId" に references がありません/);
  });

  test("mustMatch の target と via 参照先のテーブル不一致は throw", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const x = table("x", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      mId: t.string().references(() => m.id),
      name: t.string().mustMatch(() => x.name, { via: "mId" }),
    });
    expect(() => defineSchema({ a, m, x })).toThrow(/テーブルが一致しません/);
  });

  test("mustMatch の orIn が配列カラムでなければ throw", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string(), note: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      mId: t.string().references(() => m.id),
      name: t.string().mustMatch(() => m.name, { via: "mId", orIn: () => m.note as never }),
    });
    expect(() => defineSchema({ a, m })).toThrow(/配列カラムである必要があります/);
  });

  test("スコープを持たない位置（配列要素スカラー）の mustMatch は throw", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      names: t.array(t.string().mustMatch(() => m.name, { via: "id" })),
    });
    expect(() => defineSchema({ a, m })).toThrow(/オブジェクトスコープ内のフィールドにのみ/);
  });

  test("同じテーブル実体を 2 キーに登録すると throw", () => {
    const a = table("a", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a, b: a })).toThrow(/両方に登録/);
  });

  test("テーブル名の重複は throw", () => {
    const a1 = table("dup", { id: t.string().primaryKey() });
    const a2 = table("dup", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a1, a2 })).toThrow(/テーブル名 "dup" が重複/);
  });

  test("予約されたスキーマキーは throw", () => {
    const a = table("a", { id: t.string().primaryKey() });
    expect(() => defineSchema({ _: a })).toThrow(/予約/);
    expect(() => defineSchema({ $x: a })).toThrow(/予約/);
  });

  test("ネストフィールドの予約名は throw", () => {
    const a = table("a", {
      id: t.string().primaryKey(),
      items: t.array(t.object({ $index: t.number() })),
    });
    expect(() => defineSchema({ a })).toThrow(/予約されています/);
  });
});
