import { expectTypeOf, test } from "vitest";
import { t } from "./column.js";
import { createDb } from "./db.js";
import { defineSchema } from "./schema.js";
import { table } from "./table.js";
import { catalogSchema, validData } from "./testing/catalog-schema.js";

const db = createDb(catalogSchema, validData);

test("get は InferRow | undefined を返し、PK の値型を要求する", () => {
  const song = db.get(catalogSchema.songs, "s1");
  expectTypeOf(song?.title).toEqualTypeOf<string | undefined>();
  expectTypeOf(song?.artists).toEqualTypeOf<{ id: string; name: string }[] | undefined>();
  // @ts-expect-error PK は string なので number は渡せない
  db.get(catalogSchema.songs, 1);
});

test("PK 未宣言テーブルの get は型レベルで呼べない（PkValue = never）", () => {
  const noPk = table("noPk", { name: t.string() });
  const schema = defineSchema({ noPk });
  const smallDb = createDb(schema, { noPk: [] });
  // @ts-expect-error PkValue が never なので値を渡せない
  smallDb.get(schema.noPk, "x");
});

test("getBy は unique カラムのみ受け付け、所属テーブルの行型を返す", () => {
  const live = db.getBy(catalogSchema.lives.slug, "prism-2013");
  expectTypeOf(live?.name).toEqualTypeOf<string | undefined>();
  // @ts-expect-error songs.title は unique ではない
  db.getBy(catalogSchema.songs.title, "Deep Blue");
});

test("all は readonly の行配列を返す", () => {
  const events = db.all(catalogSchema.events);
  expectTypeOf(events[0]?.kind).toEqualTypeOf<
    "official_live" | "official_event" | "festival" | undefined
  >();
  // @ts-expect-error readonly 配列に push はできない
  events.push(events[0]);
});

test("createDb はスキーマキーと過不足のないデータを要求する", () => {
  const artists = table("artists2", { id: t.string().primaryKey() });
  const schema = defineSchema({ artists });
  createDb(schema, { artists: [] });
  // @ts-expect-error キーが欠けている
  createDb(schema, {});
});
