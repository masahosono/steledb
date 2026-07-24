import { expectTypeOf, test } from "vitest";
import { createDb } from "./db.js";
import { eq } from "./expr.js";
import { unnest } from "./select.js";
import { catalogSchema as s, validData } from "./testing/catalog-schema.js";

const db = createDb(s, validData);

test("a join without a projection is typed by table name (leftJoin adds | null)", () => {
  const inner = db
    .select()
    .from(s.events)
    .innerJoin(s.lives, eq(s.events.liveId, s.lives.id))
    .all();
  expectTypeOf(inner[0]?.events.id).toEqualTypeOf<string | undefined>();
  expectTypeOf(inner[0]?.lives.slug).toEqualTypeOf<string | undefined>();

  const left = db.select().from(s.events).leftJoin(s.lives, eq(s.events.liveId, s.lives.id)).all();
  const live = left[0]?.lives;
  expectTypeOf(live).toEqualTypeOf<
    | {
        id: string;
        slug: string;
        name: string;
        year: number;
        startDate: string;
        endDate: string;
        notes: string | null;
      }
    | null
    | undefined
  >();
});

test("with a projection, only whole-table entries of a leftJoin become | null", () => {
  const rows = db
    .select({ id: s.events.id, live: s.lives })
    .from(s.events)
    .leftJoin(s.lives, eq(s.events.liveId, s.lives.id))
    .all();
  expectTypeOf(rows[0]?.id).toEqualTypeOf<string | undefined>();
  const live = rows[0]?.live;
  expectTypeOf<null extends typeof live ? true : false>().toEqualTypeOf<true>();
});

test("unnest: the types of element fields, $parent, $index and $", () => {
  const item = unnest(s.setlists.items);
  expectTypeOf(item.songId).toExtend<{ readonly "~data"?: string }>();
  expectTypeOf(item.encore).toExtend<{ readonly "~data"?: number | undefined }>();
  expectTypeOf(item.$index).toExtend<{ readonly "~data"?: number }>();
  expectTypeOf(item.$parent.liveEventId).toExtend<{ readonly "~data"?: string }>();
  // @ts-expect-error a field the element does not have is an error
  item.nope;

  const rows = db
    .select({ songId: item.songId, index: item.$index, element: item.$ })
    .from(item)
    .all();
  expectTypeOf(rows).toEqualTypeOf<
    {
      songId: string;
      index: number;
      element: { no: number; encore?: number; songId: string; name: string };
    }[]
  >();
});

test("an unnest from without a projection returns an array of the element type", () => {
  const item = unnest(s.setlists.items);
  const rows = db.select().from(item).all();
  expectTypeOf(rows).toEqualTypeOf<
    { no: number; encore?: number; songId: string; name: string }[]
  >();
});
