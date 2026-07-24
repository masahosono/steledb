import { describe, expect, test } from "vitest";
import { t } from "./column.js";
import { desc } from "./expr.js";
import { ColumnRef, table } from "./table.js";

describe("カラムビルダー", () => {
  test("修飾はフラグを def に積む（primaryKey は unique を含意）", () => {
    const col = t.string().primaryKey();
    expect(col.def.primaryKey).toBe(true);
    expect(col.def.unique).toBe(true);
  });

  test("ビルダーは不変（修飾は新しいインスタンスを返す）", () => {
    const base = t.string();
    const nullable = base.nullable();
    expect(base.def.nullable).toBe(false);
    expect(nullable.def.nullable).toBe(true);
    expect(nullable).not.toBe(base);
  });

  test("enum は値一覧を def に保持する", () => {
    const col = t.enum("a", "b");
    expect(col.def.enumValues).toEqual(["a", "b"]);
  });

  test("array / object は子の def を保持する", () => {
    const col = t.array(t.object({ id: t.string(), no: t.number().optional() }));
    expect(col.def.kind).toBe("array");
    expect(col.def.element?.kind).toBe("object");
    expect(col.def.element?.shape?.id?.kind).toBe("string");
    expect(col.def.element?.shape?.no?.optional).toBe(true);
  });

  test("references: 文字列形式でカラム名を省略すると throw", () => {
    expect(() => t.string().references("lives", undefined as unknown as string)).toThrow(
      /カラム名も指定/,
    );
  });

  test("references: thunk / named の両形式が def に載る", () => {
    const lives = table("lives", { id: t.string().primaryKey() });
    const byThunk = t.string().references(() => lives.id);
    expect(byThunk.def.reference?.form).toBe("thunk");
    const byName = t.string().references("lives", "id");
    expect(byName.def.reference).toEqual({ form: "named", table: "lives", column: "id" });
  });

  test("uniqueBy は配列カラム以外で throw", () => {
    expect(() => t.string().uniqueBy(() => 1)).toThrow(/配列カラム/);
  });
});

describe("table()", () => {
  test("カラムが ColumnRef として束縛される", () => {
    const songs = table("songs", { id: t.string().primaryKey(), title: t.string() });
    expect(songs.id).toBeInstanceOf(ColumnRef);
    expect(songs.id.key).toBe("id");
    expect(songs.id.table).toBe(songs);
    expect(songs._.name).toBe("songs");
    expect(songs._.shape.title?.kind).toBe("string");
  });

  test("予約されたカラム名は throw", () => {
    expect(() => table("x", { _: t.string() })).toThrow(/予約/);
    expect(() => table("x", { "~row": t.string() })).toThrow(/予約/);
    expect(() => table("x", { $parent: t.string() })).toThrow(/予約/);
  });

  test("config コールバックは束縛済みカラムを受け取る", () => {
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
