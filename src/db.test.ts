import { describe, expect, test } from "vitest";
import { t } from "./column.js";
import { createDb, createValidatedDb } from "./db.js";
import { defineSchema } from "./schema.js";
import { table } from "./table.js";
import { cloneValidData, catalogSchema, validData } from "./testing/catalog-schema.js";

const db = createDb(catalogSchema, validData);

describe("Db: 基本クエリ", () => {
  test("get は PK で O(1) lookup できる", () => {
    expect(db.get(catalogSchema.songs, "s1")?.title).toBe("Deep Blue");
    expect(db.get(catalogSchema.songs, "s999")).toBeUndefined();
    // setlists は liveEventId が実質 PK
    expect(db.get(catalogSchema.setlists, "e1")?.items).toHaveLength(3);
  });

  test("getOrThrow は見つからないとき具体的なメッセージで throw", () => {
    expect(db.getOrThrow(catalogSchema.artists, "a1").name).toBe("Aria Vellon");
    expect(() => db.getOrThrow(catalogSchema.artists, "a999")).toThrow(
      /artists に id="a999" の行が見つかりません/,
    );
  });

  test("getBy は unique カラムで lookup できる", () => {
    expect(db.getBy(catalogSchema.lives.slug, "prism-2013")?.name).toBe("LIVE PRISM 2013");
    expect(db.getBy(catalogSchema.videos.slug, "clips-1")?.title).toBe("CLIP COLLECTION 1");
    expect(db.getBy(catalogSchema.lives.slug, "nothing")).toBeUndefined();
  });

  test("getBy は unique でないカラムを実行時にも拒否する", () => {
    expect(() => db.getBy(catalogSchema.songs.title as never, "Deep Blue")).toThrow(
      /songs.title は unique ではありません/,
    );
  });

  test("all は defaultOrder を適用する（events は eventDate 降順）", () => {
    const events = db.all(catalogSchema.events);
    expect(events.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
  });

  test("all の nulls: last が効く（songs は releaseDate 降順・null 末尾）", () => {
    const songs = db.all(catalogSchema.songs);
    expect(songs.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  test("all は defaultOrder が無ければ注入順のまま、結果はキャッシュされる", () => {
    const artists = db.all(catalogSchema.artists);
    expect(artists.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(db.all(catalogSchema.artists)).toBe(artists);
    expect(db.all(catalogSchema.events)).toBe(db.all(catalogSchema.events));
  });

  test("rowsOf は注入順の生データを返す", () => {
    expect(db.rowsOf(catalogSchema.events).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("count", () => {
    expect(db.count(catalogSchema.songs)).toBe(3);
  });

  test("スキーマ外のテーブルは throw", () => {
    const outsider = table("outsider", { id: t.string().primaryKey() });
    expect(() => db.get(outsider, "x")).toThrow(/この DB のスキーマに含まれていません/);
  });

  test("PK 未宣言テーブルへの get は throw", () => {
    const noPk = table("noPk", { name: t.string() });
    const schema = defineSchema({ noPk });
    const smallDb = createDb(schema, { noPk: [{ name: "x" }] });
    expect(() => smallDb.get(schema.noPk, "x" as never)).toThrow(/primaryKey がありません/);
  });

  test("データのキーが欠けていると throw", () => {
    expect(() => createDb(catalogSchema, { ...validData, songs: undefined as never })).toThrow(
      /テーブル "songs" のデータが配列ではありません/,
    );
  });
});

describe("createValidatedDb", () => {
  test("正常データはそのまま Db を返す", () => {
    const validated = createValidatedDb(catalogSchema, validData);
    expect(validated.count(catalogSchema.songs)).toBe(3);
  });

  test("検証エラーがあると formatErrors の内容で throw", () => {
    const data = cloneValidData();
    data.songs[0]?.artists.push({ id: "a999", name: "存在しない人" });
    expect(() => createValidatedDb(catalogSchema, data)).toThrow(/1 件の整合性エラー/);
    expect(() => createValidatedDb(catalogSchema, data)).toThrow(/artists\[1\]\.id/);
  });
});
