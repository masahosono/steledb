/**
 * A miniature kitchen-sink schema modelled on a music catalogue.
 * It covers every constraint pattern (PK/unique, composite unique, nullable FK,
 * FK inside a nested array, doubly nested FK, scalar array FK, strict/alias
 * mustMatch, uniqueBy, checks, and a table without any reference) in as few rows
 * as possible.
 * Tables that would share a shape are collapsed into a single representative.
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
    checks: [(row) => (row.endDate >= row.startDate ? null : "endDate is earlier than startDate")],
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
    sortTitle: t.string().nullable(),
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

/** The composite-key representative: a song's chart position for a given year. */
export const songRankings = table(
  "songRankings",
  {
    songId: t.string().references(() => songs.id),
    year: t.number(),
    rank: t.number(),
    note: t.string().nullable(),
  },
  (self) => ({
    // One song appears at most once per year, and no two songs share a rank
    unique: [[self.year, self.rank]],
    displayAs: (row) => `${row.songId}@${row.year}`,
  }),
);

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
  songRankings,
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
type SongRanking = InferRow<typeof songRankings>;

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
    notes: "Extra show added",
  },
];

const venueRows: Venue[] = [
  {
    id: "v1",
    name: "Grand Arena",
    alias: ["GA"],
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
    venue: "GA",
    status: "confirmed",
  },
  {
    id: "e3",
    kind: "festival",
    liveId: null,
    name: "Summer Festival Appearance",
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
    sortTitle: "deep blue",
    releaseDate: "2009-01-21",
    artists: [{ id: "a1", name: "Aria Vellon" }],
  },
  {
    id: "s2",
    title: "SILVER TIDE",
    sortTitle: "silver tide",
    releaseDate: "2005-10-19",
    artists: [
      { id: "a1", name: "Aria Vellon" },
      { id: "a2", name: "Kite Morrow" },
    ],
  },
  { id: "s3", title: "Untitled Track", sortTitle: null, releaseDate: null, artists: [] },
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
      { no: 2, songId: "s3", title: "Untitled Track (TV Size)" },
    ],
  },
  {
    id: "g2",
    title: "Double Disc Single",
    releaseDate: "2015-01-01",
    catalogNumber: null,
    tracks: [
      { no: 1, disc: 1, songId: "s2", title: "SILVER TIDE" },
      { no: 1, disc: 2, songId: "s1", title: "Deep Blue (Live)" },
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
      {
        eventId: "e2",
        tracks: [{ songId: "s1", title: "Deep Blue (Live)" }],
        note: "Partial recording",
      },
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
    notes: "Music video collection",
  },
];

const announcementRows: Announcement[] = [
  {
    id: "n1",
    publishedAt: "2026-01-01T00:00:00+09:00",
    category: "info",
    title: "Site launched",
    href: null,
  },
];

const songRankingRows: SongRanking[] = [
  { songId: "s1", year: 2013, rank: 1, note: "Peak" },
  { songId: "s2", year: 2013, rank: 2, note: null },
  // Same song in another year, and the same rank in another year: neither collides
  { songId: "s1", year: 2015, rank: 2, note: null },
];

/** Data that satisfies every constraint. */
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
  songRankings: songRankingRows,
};

/** Returns a deep copy of validData, for tests that break it on purpose. */
export function cloneValidData(): {
  [K in keyof typeof validData]: (typeof validData)[K][number][];
} {
  return structuredClone(validData) as never;
}
