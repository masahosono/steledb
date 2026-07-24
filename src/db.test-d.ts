import { expectTypeOf, test } from "vitest";
import { t } from "./column.js";
import { createDb } from "./db.js";
import { defineSchema } from "./schema.js";
import { table } from "./table.js";
import { catalogSchema, validData } from "./testing/catalog-schema.js";

const db = createDb(catalogSchema, validData);

test("get returns InferRow | undefined and demands the PK value type", () => {
  const song = db.get(catalogSchema.songs, "s1");
  expectTypeOf(song?.title).toEqualTypeOf<string | undefined>();
  expectTypeOf(song?.artists).toEqualTypeOf<{ id: string; name: string }[] | undefined>();
  // @ts-expect-error the PK is a string, so a number is not accepted
  db.get(catalogSchema.songs, 1);
});

test("get cannot be called on a table without a PK (PkValue = never)", () => {
  const noPk = table("noPk", { name: t.string() });
  const schema = defineSchema({ noPk });
  const smallDb = createDb(schema, { noPk: [] });
  // @ts-expect-error PkValue is never, so no value can be passed
  smallDb.get(schema.noPk, "x");
});

test("getBy only accepts unique columns and returns the owning table's row type", () => {
  const live = db.getBy(catalogSchema.lives.slug, "prism-2013");
  expectTypeOf(live?.name).toEqualTypeOf<string | undefined>();
  // @ts-expect-error songs.title is not unique
  db.getBy(catalogSchema.songs.title, "Deep Blue");
});

test("all returns a readonly array of rows", () => {
  const events = db.all(catalogSchema.events);
  expectTypeOf(events[0]?.kind).toEqualTypeOf<
    "official_live" | "official_event" | "festival" | undefined
  >();
  // @ts-expect-error a readonly array cannot be pushed to
  events.push(events[0]);
});

test("createDb demands data whose keys match the schema keys exactly", () => {
  const artists = table("artists2", { id: t.string().primaryKey() });
  const schema = defineSchema({ artists });
  createDb(schema, { artists: [] });
  // @ts-expect-error a key is missing
  createDb(schema, {});
});
