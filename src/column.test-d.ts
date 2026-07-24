import { expectTypeOf, test } from "vitest";
import { type ColumnData, type InferShape, t } from "./column.js";
import { type InferRow, type PkValue, table } from "./table.js";

test("the data type of primitive columns", () => {
  expectTypeOf<ColumnData<ReturnType<typeof t.string>>>().toEqualTypeOf<string>();
  expectTypeOf<ColumnData<ReturnType<typeof t.number>>>().toEqualTypeOf<number>();
  expectTypeOf<ColumnData<ReturnType<typeof t.boolean>>>().toEqualTypeOf<boolean>();
});

test("enum is inferred as a literal union", () => {
  const kind = t.enum("confirmed", "cancelled");
  expectTypeOf<ColumnData<typeof kind>>().toEqualTypeOf<"confirmed" | "cancelled">();
});

test("nullable folds | null into data", () => {
  const col = t.string().nullable();
  expectTypeOf<ColumnData<typeof col>>().toEqualTypeOf<string | null>();
});

test("nullable combined with optional", () => {
  const shape = { note: t.string().nullable().optional() };
  expectTypeOf<InferShape<typeof shape>>().toEqualTypeOf<{ note?: string | null }>();
});

test("InferRow: double nesting plus optional and enum", () => {
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
    sortTitle: t.string().nullable(),
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
    sortTitle: string | null;
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

test("PkValue: derived from the PK declaration, never when there is none", () => {
  const lives = table("lives", { id: t.string().primaryKey(), name: t.string() });
  const noPk = table("plain", { name: t.string() });
  expectTypeOf<PkValue<typeof lives>>().toEqualTypeOf<string>();
  expectTypeOf<PkValue<typeof noPk>>().toEqualTypeOf<never>();
});

test("references errors when the data type of the target column does not match", () => {
  const lives = table("lives", { id: t.string().primaryKey(), year: t.number() });
  t.string().references(() => lives.id);
  // @ts-expect-error a string column cannot reference a number column
  t.string().references(() => lives.year);
});

test("a nullable FK is matched against its target through NonNullable", () => {
  const lives = table("lives", { id: t.string().primaryKey() });
  t.string()
    .nullable()
    .references(() => lives.id);
});

test("the orIn of mustMatch only accepts an array column of the same element type", () => {
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
    // @ts-expect-error orIn has to be a string[] column
    .mustMatch(() => venues.name, { via: "venueId", orIn: () => venues.capacities });
});

test("the key function of uniqueBy receives the element type", () => {
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

test("displayAs / checks receive the row type", () => {
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
