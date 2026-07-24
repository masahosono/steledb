/**
 * 実プロジェクトのデータ 14 テーブルの「形」を再現した縮小版キッチンシンク。
 * 実データはコピーせず、全制約パターン（PK/unique、nullable FK、ネスト配列 FK、
 * 2 重ネスト FK、スカラー配列 FK、mustMatch 厳密/alias、uniqueBy、checks、
 * 参照を持たないテーブル）を最小行数で網羅する。同形状のテーブル
 * （lyricists/composers/arrangers = artists、albums/digital-singles = singles）は
 * 代表 1 つに集約している。
 */
import { t } from "../column.js";
import { desc } from "../expr.js";
import { defineSchema } from "../schema.js";
import { type InferRow, table } from "../table.js";

export const artists = table("artists", {
  id: t.string().primaryKey(),
  name: t.string(),
});

export const lives = table(
  "lives",
  {
    id: t.string().primaryKey(),
    slug: t.string().unique(),
    name: t.string(),
    year: t.number(),
    startDate: t.string(),
    endDate: t.string(),
    notes: t.string().nullable(),
  },
  () => ({
    checks: [(row) => (row.endDate >= row.startDate ? null : "endDate が startDate より前です")],
  }),
);

export const venues = table("venues", {
  id: t.string().primaryKey(),
  name: t.string(),
  alias: t.array(t.string()),
  latlon: t.object({ lat: t.number(), lon: t.number() }).nullable(),
  capacity: t.number().nullable(),
});

export const events = table(
  "events",
  {
    id: t.string().primaryKey(),
    kind: t.enum("official_live", "official_event", "festival"),
    liveId: t
      .string()
      .nullable()
      .references(() => lives.id),
    name: t.string().nullable(),
    eventDate: t.string(),
    venueId: t
      .string()
      .nullable()
      .references(() => venues.id),
    venue: t
      .string()
      .nullable()
      .mustMatch(() => venues.name, { via: "venueId", orIn: () => venues.alias }),
    status: t.enum("confirmed", "cancelled"),
  },
  (self) => ({
    defaultOrder: [desc(self.eventDate)],
    displayAs: (row) => `"${row.name ?? row.id}" (${row.id})`,
  }),
);

export const songs = table(
  "songs",
  {
    id: t.string().primaryKey(),
    title: t.string(),
    yomi: t.string().nullable(),
    releaseDate: t.string().nullable(),
    artists: t.array(
      t.object({
        id: t.string().references(() => artists.id),
        name: t.string().mustMatch(() => artists.name, { via: "id" }),
      }),
    ),
  },
  (self) => ({
    defaultOrder: [desc(self.releaseDate, { nulls: "last" })],
    displayAs: (row) => `"${row.title}" (${row.id})`,
  }),
);

export const setlists = table("setlists", {
  liveEventId: t
    .string()
    .primaryKey()
    .references(() => events.id),
  items: t.array(
    t.object({
      no: t.number(),
      encore: t.number().optional(),
      songId: t.string().references(() => songs.id),
      name: t.string(),
    }),
  ),
});

export const singles = table("singles", {
  id: t.string().primaryKey(),
  title: t.string(),
  releaseDate: t.string(),
  catalogNumber: t.string().nullable(),
  tracks: t
    .array(
      t.object({
        no: t.number(),
        disc: t.number().optional(),
        songId: t.string().references(() => songs.id),
        title: t.string(),
      }),
    )
    .uniqueBy((track) => [track.disc ?? 1, track.no]),
});

export const videos = table("videos", {
  id: t.string().primaryKey(),
  slug: t.string().unique(),
  title: t.string(),
  releaseDate: t.string(),
  kind: t.enum("pv-collection", "live-video"),
  coveredLiveIds: t.array(t.string().references(() => lives.id)),
  coveredEvents: t.array(
    t.object({
      eventId: t.string().references(() => events.id),
      tracks: t
        .array(
          t.object({
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

export const announcements = table("announcements", {
  id: t.string().primaryKey(),
  publishedAt: t.string(),
  category: t.enum("update", "planned", "info"),
  title: t.string(),
  href: t.string().nullable(),
});

export const catalogSchema = defineSchema({
  artists,
  lives,
  venues,
  events,
  songs,
  setlists,
  singles,
  videos,
  announcements,
});

type Artist = InferRow<typeof artists>;
type Live = InferRow<typeof lives>;
type Venue = InferRow<typeof venues>;
type Event = InferRow<typeof events>;
type Song = InferRow<typeof songs>;
type Setlist = InferRow<typeof setlists>;
type Single = InferRow<typeof singles>;
type Video = InferRow<typeof videos>;
type Announcement = InferRow<typeof announcements>;

const artistRows: Artist[] = [
  { id: "a1", name: "Aria Vellon" },
  { id: "a2", name: "Kite Morrow" },
];

const liveRows: Live[] = [
  {
    id: "l1",
    slug: "prism-2013",
    name: "LIVE PRISM 2013",
    year: 2013,
    startDate: "2013-01-05",
    endDate: "2013-01-06",
    notes: null,
  },
  {
    id: "l2",
    slug: "echo-2015",
    name: "LIVE ECHO 2015",
    year: 2015,
    startDate: "2015-05-10",
    endDate: "2015-05-10",
    notes: "追加公演あり",
  },
];

const venueRows: Venue[] = [
  {
    id: "v1",
    name: "Grand Arena",
    alias: ["SSA"],
    latlon: { lat: 35.894, lon: 139.63 },
    capacity: 37000,
  },
  { id: "v2", name: "Harbor Hall", alias: [], latlon: null, capacity: null },
];

const eventRows: Event[] = [
  {
    id: "e1",
    kind: "official_live",
    liveId: "l1",
    name: "LIVE PRISM 2013 DAY1",
    eventDate: "2013-01-05",
    venueId: "v1",
    venue: "Grand Arena",
    status: "confirmed",
  },
  {
    id: "e2",
    kind: "official_live",
    liveId: "l1",
    name: "LIVE PRISM 2013 DAY2",
    eventDate: "2013-01-06",
    venueId: "v1",
    venue: "SSA",
    status: "confirmed",
  },
  {
    id: "e3",
    kind: "festival",
    liveId: null,
    name: "夏フェス出演",
    eventDate: "2015-08-01",
    venueId: null,
    venue: null,
    status: "cancelled",
  },
];

const songRows: Song[] = [
  {
    id: "s1",
    title: "Deep Blue",
    yomi: "deep blue",
    releaseDate: "2009-01-21",
    artists: [{ id: "a1", name: "Aria Vellon" }],
  },
  {
    id: "s2",
    title: "SILVER TIDE",
    yomi: "silver tide",
    releaseDate: "2005-10-19",
    artists: [
      { id: "a1", name: "Aria Vellon" },
      { id: "a2", name: "Kite Morrow" },
    ],
  },
  { id: "s3", title: "未発表曲", yomi: null, releaseDate: null, artists: [] },
];

const setlistRows: Setlist[] = [
  {
    liveEventId: "e1",
    items: [
      { no: 1, songId: "s2", name: "SILVER TIDE" },
      { no: 2, songId: "s1", name: "Deep Blue" },
      { no: 3, encore: 1, songId: "s2", name: "SILVER TIDE (EN)" },
    ],
  },
  {
    liveEventId: "e2",
    items: [{ no: 1, songId: "s1", name: "Deep Blue" }],
  },
];

const singleRows: Single[] = [
  {
    id: "g1",
    title: "Deep Blue",
    releaseDate: "2009-01-21",
    catalogNumber: "CAT-1260",
    tracks: [
      { no: 1, songId: "s1", title: "Deep Blue" },
      { no: 2, songId: "s3", title: "未発表曲 (TV SIZE)" },
    ],
  },
  {
    id: "g2",
    title: "2 枚組シングル",
    releaseDate: "2015-01-01",
    catalogNumber: null,
    tracks: [
      { no: 1, disc: 1, songId: "s2", title: "SILVER TIDE" },
      { no: 1, disc: 2, songId: "s1", title: "Deep Blue (LIVE)" },
    ],
  },
];

const videoRows: Video[] = [
  {
    id: "vd1",
    slug: "prism-2013-bd",
    title: "LIVE PRISM 2013 BD",
    releaseDate: "2013-06-01",
    kind: "live-video",
    coveredLiveIds: ["l1"],
    coveredEvents: [
      { eventId: "e1" },
      { eventId: "e2", tracks: [{ songId: "s1", title: "Deep Blue (LIVE)" }], note: "一部収録" },
    ],
  },
  {
    id: "vd2",
    slug: "clips-1",
    title: "CLIP COLLECTION 1",
    releaseDate: "2003-01-22",
    kind: "pv-collection",
    coveredLiveIds: [],
    coveredEvents: [],
    notes: "PV 集",
  },
];

const announcementRows: Announcement[] = [
  {
    id: "n1",
    publishedAt: "2026-01-01T00:00:00+09:00",
    category: "info",
    title: "公開",
    href: null,
  },
];

/** 全制約を満たす正常データ */
export const validData = {
  artists: artistRows,
  lives: liveRows,
  venues: venueRows,
  events: eventRows,
  songs: songRows,
  setlists: setlistRows,
  singles: singleRows,
  videos: videoRows,
  announcements: announcementRows,
};

/** validData の deep copy を返す（テストで壊して使う用） */
export function cloneValidData(): {
  [K in keyof typeof validData]: (typeof validData)[K][number][];
} {
  return structuredClone(validData) as never;
}
