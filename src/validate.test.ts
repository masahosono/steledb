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
    const video = data.videos[1] as { notes?: string };
    delete video.notes;
    expect(errorsOf(data)).toEqual([]);
  });

  test("必須キーの欠落を検出する", () => {
    const data = cloneValidData();
    delete (data.venues[0] as { name?: string }).name;
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
    const coverage = data.videos[0]?.coveredEvents[1] as { tracks?: { songId?: string }[] };
    delete coverage.tracks?.[0]?.songId;
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
