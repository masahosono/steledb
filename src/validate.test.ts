import { describe, expect, test } from "vitest";
import type { ValidationError } from "./errors.js";
import { cloneValidData, catalogSchema, validData } from "./testing/catalog-schema.js";
import { validate } from "./validate.js";

function errorsOf(data: ReturnType<typeof cloneValidData>): readonly ValidationError[] {
  return validate(catalogSchema, data).errors;
}

describe("validate: shape 検証", () => {
  test("正常データはエラーなし", () => {
    const result = validate(catalogSchema, validData);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("プリミティブの型不一致を検出する", () => {
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

  test("nullable でないカラムの null を検出する", () => {
    const data = cloneValidData();
    (data.songs[0] as { title: unknown }).title = null;
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({ code: "SHAPE_MISMATCH", pathString: "title" });
    expect(errors[0]?.message).toContain("null は許可されていません");
  });

  test("nullable の null と optional の欠落は合格する", () => {
    const data = cloneValidData();
    (data.songs[0] as { yomi: string | null }).yomi = null;
    Reflect.deleteProperty(data.videos[1] as object, "notes");
    expect(errorsOf(data)).toEqual([]);
  });

  test("必須キーの欠落を検出する", () => {
    const data = cloneValidData();
    Reflect.deleteProperty(data.venues[0] as object, "name");
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "SHAPE_MISMATCH",
      table: "venues",
      pathString: "name",
    });
    expect(errors[0]?.message).toContain("必須キーがありません");
  });

  test("enum 外の値を検出する", () => {
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

  test("スキーマに無いキーを検出する（unknownKeys: ignore で抑制できる）", () => {
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

  test("ネスト配列要素の型不一致は具体的なインデックスつきで検出する", () => {
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

  test("2 重ネストの欠落キーを検出する", () => {
    const data = cloneValidData();
    const track = data.videos[0]?.coveredEvents[1]?.tracks?.[0];
    if (track === undefined) throw new Error("fixture が想定と異なります");
    Reflect.deleteProperty(track, "songId");
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      table: "videos",
      pathString: "coveredEvents[1].tracks[0].songId",
    });
  });

  test("行がオブジェクトでない場合を検出する", () => {
    const data = cloneValidData();
    (data.artists as unknown[]).push("not-a-row");
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({ code: "SHAPE_MISMATCH", table: "artists", path: [] });
    expect(errors[0]?.rowLabel).toBe("(行 2)");
  });

  test("rowLabel は displayAs を使い、壊れた行でもフォールバックする", () => {
    const data = cloneValidData();
    (data.songs[0] as { title: unknown }).title = 123;
    const errors = errorsOf(data);
    // displayAs は title を埋め込むが、123 でも文字列化されるのでそのまま使われる
    expect(errors[0]?.rowLabel).toBe('"123" (s1)');

    (data.venues[1] as { name: unknown }).name = 5;
    const venueErrors = errorsOf(data).filter((e) => e.table === "venues");
    // venues に displayAs は無いので PK フォールバック
    expect(venueErrors[0]?.rowLabel).toBe("(id=v2)");
  });

  test("テーブルのデータが配列でなければ throw", () => {
    const data = cloneValidData();
    expect(() => validate(catalogSchema, { ...data, artists: undefined as never })).toThrow(
      /テーブル "artists" のデータが配列ではありません/,
    );
  });

  test("全エラーを列挙する（fail-fast しない）", () => {
    const data = cloneValidData();
    (data.lives[0] as { year: unknown }).year = "2013";
    (data.songs[0] as { title: unknown }).title = null;
    (data.artists[0] as Record<string, unknown>).nickname = "x";
    expect(errorsOf(data)).toHaveLength(3);
  });
});

/**
 * 既存の検証スクリプト の検証項目との 1:1 対応表。
 *
 * | check-data.mjs の検証                             | steledb でのエラー種別    | テスト |
 * |---------------------------------------------------|---------------------------|--------|
 * | 各テーブルの id 重複                              | DUPLICATE_KEY             | PK の重複 |
 * | lives の slug 重複                                | DUPLICATE_KEY             | unique カラムの重複 |
 * | setlists の liveEventId 重複（1 公演 1 セトリ）   | DUPLICATE_KEY             | 実質 PK の重複 |
 * | songs のクレジット参照 id がマスタに存在するか    | FK_VIOLATION              | ネスト配列 FK |
 * | songs のクレジット冗長 name がマスタと一致するか  | DENORMALIZED_MISMATCH     | mustMatch 厳密一致 |
 * | events の liveId / venueId が存在するか           | FK_VIOLATION              | nullable スカラー FK |
 * | events.venue が venue.name / alias と一致するか   | DENORMALIZED_MISMATCH     | mustMatch alias 許容 |
 * | setlists の liveEventId が events に存在するか    | FK_VIOLATION              | PK 兼 FK |
 * | setlists.items[].songId が songs に存在するか     | FK_VIOLATION              | ネスト配列 FK |
 * | singles/albums の tracks[].songId が存在するか    | FK_VIOLATION              | ネスト配列 FK |
 * | singles/albums の (disc, no) がディスク内で一意か | SCOPED_DUPLICATE          | uniqueBy |
 *
 * check-data.mjs に無い追加検証: videos の 3 系統の FK（coveredLiveIds[] /
 * coveredEvents[].eventId / coveredEvents[].tracks[].songId）、shape 検証、
 * カスタム checks。
 */
describe("validate: 制約検証（check-data.mjs 1:1 対応）", () => {
  test("PK の重複を検出する", () => {
    const data = cloneValidData();
    data.artists.push({ id: "a1", name: "重複アーティスト" });
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

  test("unique カラム（lives.slug）の重複を検出する", () => {
    const data = cloneValidData();
    const clone = structuredClone(data.lives[0]);
    if (clone === undefined) throw new Error("fixture が空です");
    clone.id = "l99";
    const errors = errorsOf({ ...data, lives: [...data.lives, clone] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "DUPLICATE_KEY", column: "slug", value: "prism-2013" });
  });

  test("実質 PK（setlists.liveEventId）の重複を検出する", () => {
    const data = cloneValidData();
    data.setlists.push({ liveEventId: "e1", items: [] });
    const errors = errorsOf(data);
    expect(errors[0]).toMatchObject({
      code: "DUPLICATE_KEY",
      table: "setlists",
      column: "liveEventId",
    });
  });

  test("ネスト配列 FK（songs.artists[].id）の参照切れを検出する", () => {
    const data = cloneValidData();
    data.songs[0]?.artists.push({ id: "a999", name: "存在しない人" });
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

  test("mustMatch 厳密一致（songs.artists[].name）の不一致を検出する", () => {
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
    expect(errors[0]?.message).toContain("一致しません");
  });

  test("nullable スカラー FK（events.liveId / venueId）の参照切れを検出する", () => {
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

  test("mustMatch alias 許容（events.venue）: name とも alias とも一致しなければエラー", () => {
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
      allowedAliases: ["SSA"],
    });
    expect(errors[0]?.message).toContain("alias にも含まれません");
  });

  test("setlists.items[].songId / singles.tracks[].songId の参照切れを検出する", () => {
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

  test("uniqueBy（tracks の (disc ?? 1, no)）の重複を検出する", () => {
    const data = cloneValidData();
    // disc 未指定 (=1) の no:1 と disc:1 の no:1 が衝突するケース
    data.singles[0]?.tracks.push({ no: 1, disc: 1, songId: "s2", title: "重複トラック" });
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

  test("videos の 3 系統 FK（check-data.mjs 未検証だった穴）を検出する", () => {
    const data = cloneValidData();
    const video = data.videos[0];
    if (video === undefined) throw new Error("fixture が空です");
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

  test("カスタム checks（lives の日付整合）を検出する", () => {
    const data = cloneValidData();
    const live = data.lives[0];
    if (live) live.endDate = "2012-12-31";
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "CHECK_FAILED",
      table: "lives",
      detail: "endDate が startDate より前です",
    });
  });

  test("shape が壊れた行は関係検証をスキップする（ノイズ削減）", () => {
    const data = cloneValidData();
    const event = data.events[0] as Record<string, unknown>;
    event.liveId = 123; // 型違い: shape エラーになり、FK 検証はスキップされる
    const errors = errorsOf(data);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("SHAPE_MISMATCH");
  });
});
