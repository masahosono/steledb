import { describe, expect, test } from "vitest";
import { t } from "./column.js";
import { constraintsOf, defineSchema, formatPath } from "./schema.js";
import { table } from "./table.js";
import { catalogSchema } from "./testing/catalog-schema.js";

describe("defineSchema: resolving the kitchen sink", () => {
  test("the kitchen-sink schema survives freezing", () => {
    expect(catalogSchema._.tables.size).toBe(10);
    expect(catalogSchema.songs._.name).toBe("songs");
  });

  test("PK / unique are resolved (uniques includes the PK)", () => {
    const lives = constraintsOf(catalogSchema, "lives");
    expect(lives.pk).toBe("id");
    expect(lives.uniques).toEqual(["id", "slug"]);
    const setlists = constraintsOf(catalogSchema, "setlists");
    expect(setlists.pk).toBe("liveEventId");
  });

  test("paths resolve for nested array FKs, doubly nested FKs and scalar array FKs", () => {
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

  test("mustMatch resolves into viaTarget / target / orIn", () => {
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

  test("a table-level unique resolves to its column keys", () => {
    const rankings = constraintsOf(catalogSchema, "songRankings");
    expect(rankings.compositeUniques).toEqual([["year", "rank"]]);
    // A table that declares none gets an empty list, not undefined
    expect(constraintsOf(catalogSchema, "artists").compositeUniques).toEqual([]);
  });

  test("uniqueBy resolves to the array path", () => {
    const singles = constraintsOf(catalogSchema, "singles");
    expect(singles.uniqueBys).toHaveLength(1);
    expect(formatPath(singles.uniqueBys[0]?.path ?? [])).toBe("tracks");
  });

  test("a table without references ends up with empty constraints", () => {
    const announcements = constraintsOf(catalogSchema, "announcements");
    expect(announcements.references).toEqual([]);
    expect(announcements.mustMatches).toEqual([]);
  });
});

describe("defineSchema: detecting invalid schemas", () => {
  test("a thunk reference to a table outside the schema throws", () => {
    const outside = table("outside", { id: t.string().primaryKey() });
    const a = table("a", {
      id: t.string().primaryKey(),
      ref: t.string().references(() => outside.id),
    });
    expect(() => defineSchema({ a })).toThrow(/is not registered in the schema/);
  });

  test("a typo in the string form throws, listing the registered tables", () => {
    const a = table("a", { id: t.string().primaryKey(), ref: t.string().references("bbb", "id") });
    const b = table("b", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a, b })).toThrow(
      /referenced table "bbb" does not exist in the schema.*registered: a, b/,
    );
  });

  test("a missing target column in the string form throws", () => {
    const a = table("a", { id: t.string().primaryKey(), ref: t.string().references("b", "slug") });
    const b = table("b", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a, b })).toThrow(/referenced column "b.slug" does not exist/);
  });

  test("an FK pointing at a non-unique column throws", () => {
    const b = table("b", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", { id: t.string().primaryKey(), ref: t.string().references(() => b.name) });
    expect(() => defineSchema({ a, b })).toThrow(/is not unique/);
  });

  test("more than one primaryKey throws", () => {
    const a = table("a", { id: t.string().primaryKey(), slug: t.string().primaryKey() });
    expect(() => defineSchema({ a })).toThrow(/multiple primaryKey/);
  });

  test("unique / primaryKey on a nested column throws", () => {
    const a = table("a", {
      id: t.string().primaryKey(),
      items: t.array(t.object({ code: t.string().unique() })),
    });
    expect(() => defineSchema({ a })).toThrow(/only be applied to top-level columns/);
  });

  test("a mustMatch whose via is not in the same scope throws", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      name: t.string().mustMatch(() => m.name, { via: "mId" }),
    });
    expect(() => defineSchema({ a, m })).toThrow(/via "mId" does not exist in the same scope/);
  });

  test("a mustMatch whose via has no references throws", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      mId: t.string(),
      name: t.string().mustMatch(() => m.name, { via: "mId" }),
    });
    expect(() => defineSchema({ a, m })).toThrow(/via "mId" has no references/);
  });

  test("a mustMatch whose target and via target differ in table throws", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const x = table("x", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      mId: t.string().references(() => m.id),
      name: t.string().mustMatch(() => x.name, { via: "mId" }),
    });
    expect(() => defineSchema({ a, m, x })).toThrow(/belong to different tables/);
  });

  test("a mustMatch whose orIn is not an array column throws", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string(), note: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      mId: t.string().references(() => m.id),
      name: t.string().mustMatch(() => m.name, { via: "mId", orIn: () => m.note as never }),
    });
    expect(() => defineSchema({ a, m })).toThrow(/must be an array column/);
  });

  test("a mustMatch in a position without a scope (a scalar array element) throws", () => {
    const m = table("m", { id: t.string().primaryKey(), name: t.string() });
    const a = table("a", {
      id: t.string().primaryKey(),
      names: t.array(t.string().mustMatch(() => m.name, { via: "id" })),
    });
    expect(() => defineSchema({ a, m })).toThrow(/inside an object scope/);
  });

  test("a composite unique of a single column throws", () => {
    const a = table("a", { id: t.string().primaryKey(), code: t.string() }, (self) => ({
      unique: [[self.code]],
    }));
    expect(() => defineSchema({ a })).toThrow(/needs two or more columns/);
  });

  test("a composite unique borrowing another table's column throws", () => {
    const b = table("b", { id: t.string().primaryKey(), code: t.string() });
    const a = table("a", { id: t.string().primaryKey(), code: t.string() }, (self) => ({
      unique: [[self.code, b.code as never]],
    }));
    expect(() => defineSchema({ a, b })).toThrow(/belongs to another table/);
  });

  test("a composite unique over a non-scalar column throws", () => {
    const a = table(
      "a",
      { id: t.string().primaryKey(), code: t.string(), tags: t.array(t.string()) },
      (self) => ({ unique: [[self.code, self.tags]] }),
    );
    expect(() => defineSchema({ a })).toThrow(/only scalar columns can take part in a key/);
  });

  test("a composite unique repeating a column throws", () => {
    const a = table("a", { id: t.string().primaryKey(), code: t.string() }, (self) => ({
      unique: [[self.code, self.code]],
    }));
    expect(() => defineSchema({ a })).toThrow(/appears more than once/);
  });

  test("declaring the same composite unique twice throws", () => {
    const a = table(
      "a",
      { id: t.string().primaryKey(), code: t.string(), lang: t.string() },
      (self) => ({
        unique: [
          [self.code, self.lang],
          [self.code, self.lang],
        ],
      }),
    );
    expect(() => defineSchema({ a })).toThrow(/is declared more than once/);
  });

  test("a composite unique that forgot the inner list throws with a hint", () => {
    const a = table("a", { id: t.string().primaryKey(), code: t.string() }, (self) => ({
      unique: [self.code as never, self.id as never],
    }));
    expect(() => defineSchema({ a })).toThrow(/unique: \[\[a, b\]\]/);
  });

  test("registering the same table under two keys throws", () => {
    const a = table("a", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a, b: a })).toThrow(/registered under both schema keys/);
  });

  test("a duplicate table name throws", () => {
    const a1 = table("dup", { id: t.string().primaryKey() });
    const a2 = table("dup", { id: t.string().primaryKey() });
    expect(() => defineSchema({ a1, a2 })).toThrow(/duplicate table name "dup"/);
  });

  test("a reserved schema key throws", () => {
    const a = table("a", { id: t.string().primaryKey() });
    expect(() => defineSchema({ _: a })).toThrow(/reserved/);
    expect(() => defineSchema({ $x: a })).toThrow(/reserved/);
  });

  test("a reserved nested field name throws", () => {
    const a = table("a", {
      id: t.string().primaryKey(),
      items: t.array(t.object({ $index: t.number() })),
    });
    expect(() => defineSchema({ a })).toThrow(/reserved/);
  });
});
