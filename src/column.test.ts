import { describe, expect, test } from "vitest";
import { t } from "./column.js";
import { desc } from "./expr.js";
import { ColumnRef, table } from "./table.js";

describe("column builders", () => {
  test("modifiers accumulate flags on the def (primaryKey implies unique)", () => {
    const col = t.string().primaryKey();
    expect(col.def.primaryKey).toBe(true);
    expect(col.def.unique).toBe(true);
  });

  test("builders are immutable (a modifier returns a new instance)", () => {
    const base = t.string();
    const nullable = base.nullable();
    expect(base.def.nullable).toBe(false);
    expect(nullable.def.nullable).toBe(true);
    expect(nullable).not.toBe(base);
  });

  test("enum keeps the list of values on the def", () => {
    const col = t.enum("a", "b");
    expect(col.def.enumValues).toEqual(["a", "b"]);
  });

  test("array / object keep their child defs", () => {
    const col = t.array(t.object({ id: t.string(), no: t.number().optional() }));
    expect(col.def.kind).toBe("array");
    expect(col.def.element?.kind).toBe("object");
    expect(col.def.element?.shape?.id?.kind).toBe("string");
    expect(col.def.element?.shape?.no?.optional).toBe(true);
  });

  test("references: the string form throws when the column name is omitted", () => {
    expect(() => t.string().references("lives", undefined as unknown as string)).toThrow(
      /also requires a column name/,
    );
  });

  test("references: both the thunk and named forms land on the def", () => {
    const lives = table("lives", { id: t.string().primaryKey() });
    const byThunk = t.string().references(() => lives.id);
    expect(byThunk.def.reference?.form).toBe("thunk");
    const byName = t.string().references("lives", "id");
    expect(byName.def.reference).toEqual({ form: "named", table: "lives", column: "id" });
  });

  test("uniqueBy throws on anything but an array column", () => {
    expect(() => t.string().uniqueBy(() => 1)).toThrow(/array columns/);
  });
});

describe("table()", () => {
  test("columns are bound as ColumnRefs", () => {
    const songs = table("songs", { id: t.string().primaryKey(), title: t.string() });
    expect(songs.id).toBeInstanceOf(ColumnRef);
    expect(songs.id.key).toBe("id");
    expect(songs.id.table).toBe(songs);
    expect(songs._.name).toBe("songs");
    expect(songs._.shape.title?.kind).toBe("string");
  });

  test("reserved column names throw", () => {
    expect(() => table("x", { _: t.string() })).toThrow(/reserved/);
    expect(() => table("x", { "~row": t.string() })).toThrow(/reserved/);
    expect(() => table("x", { $parent: t.string() })).toThrow(/reserved/);
  });

  test("the config callback receives the bound columns", () => {
    const events = table(
      "events",
      { id: t.string().primaryKey(), eventDate: t.string() },
      (self) => ({
        defaultOrder: [desc(self.eventDate)],
        displayAs: (row) => row.id,
      }),
    );
    expect(events._.config.defaultOrder).toHaveLength(1);
    expect(events._.config.defaultOrder?.[0]?.direction).toBe("desc");
    expect(events._.config.defaultOrder?.[0]?.expr).toBe(events.eventDate);
  });
});
