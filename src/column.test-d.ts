import { expectTypeOf, test } from "vitest";
import { type ColumnData, type InferShape, t } from "./column.js";
import { type InferRow, type PkValue, table } from "./table.js";

test("プリミティブカラムの data 型", () => {
  expectTypeOf<ColumnData<ReturnType<typeof t.string>>>().toEqualTypeOf<string>();
  expectTypeOf<ColumnData<ReturnType<typeof t.number>>>().toEqualTypeOf<number>();
  expectTypeOf<ColumnData<ReturnType<typeof t.boolean>>>().toEqualTypeOf<boolean>();
});

test("enum はリテラルユニオンに推論される", () => {
  const kind = t.enum("confirmed", "cancelled");
  expectTypeOf<ColumnData<typeof kind>>().toEqualTypeOf<"confirmed" | "cancelled">();
});

test("nullable は data に | null を折り込む", () => {
  const col = t.string().nullable();
  expectTypeOf<ColumnData<typeof col>>().toEqualTypeOf<string | null>();
});

test("nullable + optional の組み合わせ", () => {
  const shape = { note: t.string().nullable().optional() };
  expectTypeOf<InferShape<typeof shape>>().toEqualTypeOf<{ note?: string | null }>();
});

test("InferRow: videos 相当の 2 重ネスト + optional + enum", () => {
  const lives = table("lives", {
    id: t.string().primaryKey(),
    slug: t.string().unique(),
  });
  const events = table("events", {
    id: t.string().primaryKey(),
    liveId: t
      .string()
      .nullable()
      .references(() => lives.id),
  });
  const songs = table("songs", {
    id: t.string().primaryKey(),
    title: t.string(),
  });
  const videos = table("videos", {
    id: t.string().primaryKey(),
    slug: t.string().unique(),
    title: t.string(),
    yomi: t.string().nullable(),
    kind: t.enum("pv-collection", "live-video"),
    coveredLiveIds: t.array(t.string().references(() => lives.id)),
    coveredEvents: t.array(
      t.object({
        eventId: t.string().references(() => events.id),
        tracks: t
          .array(
            t.object({
              no: t.number().optional(),
              songId: t.string().references(() => songs.id),
              title: t.string(),
            }),
          )
          .optional(),
        note: t.string().optional(),
      }),
    ),
    notes: t.string().optional(),
  });

  expectTypeOf<InferRow<typeof videos>>().toEqualTypeOf<{
    id: string;
    slug: string;
    title: string;
    yomi: string | null;
    kind: "pv-collection" | "live-video";
    coveredLiveIds: string[];
    coveredEvents: {
      eventId: string;
      tracks?: { no?: number; songId: string; title: string }[];
      note?: string;
    }[];
    notes?: string;
  }>();

  expectTypeOf<InferRow<typeof events>>().toEqualTypeOf<{
    id: string;
    liveId: string | null;
  }>();
});

test("PkValue: PK 宣言から値型が導出され、未宣言なら never", () => {
  const lives = table("lives", { id: t.string().primaryKey(), name: t.string() });
  const noPk = table("plain", { name: t.string() });
  expectTypeOf<PkValue<typeof lives>>().toEqualTypeOf<string>();
  expectTypeOf<PkValue<typeof noPk>>().toEqualTypeOf<never>();
});

test("references は参照先カラムの data 型が一致しないとエラー", () => {
  const lives = table("lives", { id: t.string().primaryKey(), year: t.number() });
  t.string().references(() => lives.id);
  // @ts-expect-error string カラムから number カラムへの参照は型不一致
  t.string().references(() => lives.year);
});

test("nullable FK は NonNullable で参照先と突き合わせる", () => {
  const lives = table("lives", { id: t.string().primaryKey() });
  t.string()
    .nullable()
    .references(() => lives.id);
});

test("mustMatch の orIn は同じ要素型の配列カラムのみ受け付ける", () => {
  const venues = table("venues", {
    id: t.string().primaryKey(),
    name: t.string(),
    alias: t.array(t.string()),
    capacities: t.array(t.number()),
  });
  t.string()
    .nullable()
    .mustMatch(() => venues.name, { via: "venueId", orIn: () => venues.alias });
  t.string()
    .nullable()
    // @ts-expect-error orIn は string[] カラムである必要がある
    .mustMatch(() => venues.name, { via: "venueId", orIn: () => venues.capacities });
});

test("uniqueBy のキー抽出関数は要素型を受け取る", () => {
  const tracks = t
    .array(t.object({ no: t.number(), disc: t.number().optional(), songId: t.string() }))
    .uniqueBy((track) => {
      expectTypeOf(track).toEqualTypeOf<{ no: number; disc?: number; songId: string }>();
      return [track.disc ?? 1, track.no];
    });
  expectTypeOf<ColumnData<typeof tracks>>().toEqualTypeOf<
    { no: number; disc?: number; songId: string }[]
  >();
});

test("displayAs / checks は行型を受け取る", () => {
  table(
    "songs",
    {
      id: t.string().primaryKey(),
      title: t.string(),
      releaseDate: t.string().nullable(),
    },
    (self) => ({
      displayAs: (row) => {
        expectTypeOf(row).toEqualTypeOf<{
          id: string;
          title: string;
          releaseDate: string | null;
        }>();
        return row.title;
      },
      checks: [
        (row) => {
          expectTypeOf(row.releaseDate).toEqualTypeOf<string | null>();
          return null;
        },
      ],
      defaultOrder: [],
    }),
  );
  void table;
});
