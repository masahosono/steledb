# steledb

A TypeScript library that treats a set of JSON files as a static relational database.

For version-controlled static data (one JSON file holding one table's array of records), a Drizzle-style schema definition gives you two things:

1. **Relational integrity checks** — PK / unique (both single-column and composite) / FK (including nested arrays, double nesting and scalar arrays) / denormalized field agreement / scoped composite uniqueness / custom checks
2. **A typed query API** — O(1) lookups / a select builder (where, projection, orderBy) / unnest over nested arrays / joins / aggregation

Write the schema once and both the validation logic and the TypeScript row types are derived from it. A change in the data structure only needs a change to the schema, with nothing hard-coded into a validation script. In workflows where an AI edits the data files, validation — including the detection of unknown keys — acts as the gate.

## Highlights

- **The core has zero runtime dependencies, does not touch the filesystem, and is ESM only.** Data is injected as already-parsed arrays, so it bundles as-is for environments without a filesystem, such as Cloudflare Workers
- **The API is fully synchronous.** The data is in memory, so nothing returns a Promise. Terminal methods return plain arrays, which keeps the native array methods available as an escape hatch at all times
- **The Node helpers live behind their own entry point** (`steledb/node`), providing filesystem loading and a validation runner for CI
- **A GUI console comes with it.** [`steledb studio`](#the-studio) browses the data in a browser, follows foreign keys in both directions, and edits rows without reformatting the file

## Installation

It is not published to npm, so depend on it through a `file:` reference.

```jsonc
// the consuming project's package.json
{
  "dependencies": {
    "steledb": "file:../steledb"
  }
}
```

steledb has to be built first, because a `file:` reference does not run prepare.

```bash
cd steledb && npm install && npm run build   # npm run dev watches during development
```

When using it from Vite or Astro, set `optimizeDeps.exclude: ["steledb"]` if pre-bundling breaks the symlink.

## Quickstart

The complete example lives in [`example/`](example/) — a standalone project depending on steledb through a `file:` reference: the schema in [`src/db/schema.ts`](example/src/db/schema.ts), one JSON file per table under [`src/data/`](example/src/data/), the query layer in [`src/index.ts`](example/src/index.ts), and [`src/index.test.ts`](example/src/index.test.ts) keeping the code below honest.

### 1. Define the schema

```ts
import { defineSchema, desc, t, table, type InferRow } from "steledb";

const authors = table("authors", {
  id: t.string().primaryKey(),
  name: t.string(), // not unique: two authors are allowed to share a name
});

const awards = table("awards", {
  id: t.string().primaryKey(),
  name: t.string().unique(), // an award name, unlike a person's, is one of a kind
});

const books = table(
  "books",
  {
    id: t.string().primaryKey(),
    slug: t.string().unique(),
    title: t.string(),
    publishedYear: t.number().nullable(),
    credits: t.array(
      t.object({
        authorId: t.string().references(() => authors.id),
        authorName: t.string().mustMatch(() => authors.name, { via: "authorId" }),
      }),
    ),
    // The same award cannot be won twice in one year — but one year can bring
    // several awards, so neither half of the key would do on its own
    awards: t
      .array(
        t.object({
          awardId: t.string().references(() => awards.id),
          year: t.number(),
          citation: t.string().optional(),
        }),
      )
      .uniqueBy((win) => [win.awardId, win.year]),
    tags: t.array(t.string()),
  },
  (self) => ({
    defaultOrder: [desc(self.publishedYear, { nulls: "last" })],
    displayAs: (row) => `"${row.title}" (${row.id})`,
  }),
);

export const schema = defineSchema({ authors, awards, books });

type Book = InferRow<typeof books>; // row types are inferred, never hand-written
```

`defineSchema()` freezes the schema and **validates it at runtime right there**: that the targets exist, that FK targets are unique, that the `via` sibling exists, that there is at most one PK, and so on. A broken schema fails the moment it is imported.

### 2. Validate

```ts
import { formatErrors, validate } from "steledb";

const result = validate(schema, { authors, awards, books }); // data is Record<schema key, unknown[]>
if (!result.ok) {
  console.error(formatErrors(result.errors)); // every error, human readable
  // result.errors is structured data (code / table / rowLabel / path / pathString ...)
}
```

### 3. Query

```ts
import { createDb, eq, some, unnest } from "steledb";

const db = createDb(schema, data); // no validation (CI is assumed to have done it)

db.get(schema.books, "b1");                  // O(1) by PK -> Book | undefined
db.getBy(schema.books.slug, "second-book");  // O(1) by a unique column
db.all(schema.books);                        // everything, with defaultOrder applied

// The select builder: the return type is inferred from the projection
db.select({ id: schema.books.id, title: schema.books.title })
  .from(schema.books)
  .where(some(schema.books.credits, (credit) => eq(credit.authorId, "a2")))
  .all(); // { id: string; title: string }[]

// unnest expands a nested array into rows; $parent reaches the row it came from
const win = unnest(schema.books.awards);
db.select({ year: win.year, title: win.$parent.title })
  .from(win)
  .where(eq(win.awardId, "hugo"))
  .all(); // { year: number; title: string }[]
```

## Schema DSL reference

### Column types and modifiers

| Builder | Row type |
|---|---|
| `t.string()` / `t.number()` / `t.boolean()` | `string` / `number` / `boolean` |
| `t.enum("a", "b")` | `"a" \| "b"` (a literal union) |
| `t.array(inner)` | `Inner[]` |
| `t.object({ ... })` | a nested object |
| `.nullable()` | `T \| null` |
| `.optional()` | `key?: T` (the key may be absent from the JSON) |
| `.primaryKey()` | The primary key. Implies unique. One column per table |
| `.unique()` | No duplicates across the table (multiple nulls are fine) |

`optional` only ever means "the key is missing", because JSON has no undefined. On a table without a real primary key, put `.primaryKey()` on the column that acts as one (for example `setlists.liveEventId`). A key made of several columns goes in the [table options](#table-level-composite-keys) instead.

### Reference constraints

```ts
// A foreign key. The thunk form is the default (safe under refactoring)
liveId: t.string().nullable().references(() => lives.id),

// The string form, a fallback for cases such as circular references where the types cannot be built
liveId: t.string().references("lives", "id"),

// Scalar array FKs, FKs inside a nested array and doubly nested FKs are written the same way
coveredLiveIds: t.array(t.string().references(() => lives.id)),
```

An FK has to point at a `primaryKey` or `unique` column. Values that are null or whose key is missing are not checked (nullable FKs, optional FKs).

### Checking denormalized fields (mustMatch)

For a field that redundantly holds something like the name of its target. Name the FK field in the same object scope with `via`, and the value is compared against the master row.

```ts
// Strict: artists[].name must equal the master name exactly
name: t.string().mustMatch(() => artists.name, { via: "id" }),

// Alias-tolerant: venue is fine if it equals venues.name or appears in venues.alias[]
venue: t.string().nullable().mustMatch(() => venues.name, {
  via: "venueId",
  orIn: () => venues.alias,
}),

// No check = do not declare one (for fields where spelling variations are acceptable)
```

### Scoped composite uniqueness (uniqueBy)

Forbids duplicates within an array inside a parent record. Because it takes a key function, defaults fall out naturally.

```ts
tracks: t.array(trackShape).uniqueBy((track) => [track.disc ?? 1, track.no]),
```

### Table-level composite keys

`.primaryKey()` and `.unique()` cover one column. When it takes a combination of columns to identify a record — the usual shape of a join table — declare it in the table options, where the columns are reachable through `self`.

```ts
table("songRankings", {
  songId: t.string().references(() => songs.id),
  year: t.number(),
  rank: t.number(),
}, (self) => ({
  primaryKey: [self.songId, self.year],  // a song appears at most once per year
  unique: [[self.year, self.rank]],      // no two songs share a rank in the same year
}));
```

Each entry lists two or more of the table's own scalar columns (for a single column use `.primaryKey()` / `.unique()` on the column itself, which is also what a foreign key can point at). Several unique combinations can be declared at once: `unique: [[a, b], [c, d]]`.

A composite primary key forbids duplicates on its own, exactly as `.primaryKey()` implies `.unique()`, and its members cannot be `.nullable()` or `.optional()`. Declaring one both ways — a `.primaryKey()` column plus `primaryKey` in the config — is an error, since a table has at most one primary key.

`db.get()` then takes the key as a tuple in the declared order, and the order is checked at compile time.

```ts
db.get(songRankings, ["s1", 2013]);
db.get(songRankings, [2013, "s1"]); // a type error: the members are (songId, year)
```

As in SQL, where NULLs are distinct, a unique tuple with a null or missing member is not comparable and so never collides.

A foreign key still points at a single column, so it cannot target a composite key. Point it at a `primaryKey` / `unique` column, or check the combination with `checks`.

### Table options

```ts
table("events", { ... }, (self) => ({
  defaultOrder: [desc(self.eventDate)],            // the default sort for db.all() and select
  displayAs: (row) => `"${row.name}" (${row.id})`, // how a row is identified in validation errors
  checks: [(row) => (row.endDate >= row.startDate ? null : "endDate is earlier than startDate")],
  primaryKey: [self.songId, self.year],            // a composite primary key
  unique: [[self.year, self.rank]],                // composite unique constraints
}));
```

## Validation

```ts
const result = validate(schema, data, { unknownKeys: "error" }); // "error" is the default
```

The order is: **shape** (types, enums, nullable/optional violations, unknown keys) → **PK/unique duplicates** (single-column and composite) → **FK existence** → **mustMatch** → **uniqueBy** → **checks**. It does not fail fast; everything is collected, and rows with a broken shape skip the relational checks to keep the noise down.

Errors are structured data in a discriminated union.

```ts
type ValidationError = {
  table: string;            // the schema key
  rowIndex: number;
  rowKey: string | number | null;   // the PK value
  rowLabel: string;         // the result of displayAs
  path: (string | number)[];        // ["coveredEvents", 0, "tracks", 3, "songId"]
  pathString: string;       // "coveredEvents[0].tracks[3].songId"
  message: string;
} & (
  | { code: "SHAPE_MISMATCH"; expected: string; actual: unknown }
  | { code: "UNKNOWN_KEY"; key: string }
  | { code: "DUPLICATE_KEY"; column: string; value: unknown; otherRowIndex: number }
  | { code: "DUPLICATE_COMPOSITE_KEY"; columns: string[]; values: unknown[];
      otherRowIndex: number }
  | { code: "FK_VIOLATION"; value: unknown; refTable: string; refColumn: string }
  | { code: "DENORMALIZED_MISMATCH"; actual: unknown; expected: unknown;
      allowedAliases?: unknown[]; refTable: string; refKeyPath: string }
  | { code: "SCOPED_DUPLICATE"; scopePath: string; key: unknown[] }
  | { code: "CHECK_FAILED"; detail: string }
);
```

## Queries

### The basics

```ts
const db = createDb(schema, data);          // the data is trusted and held as-is (zero cost)
const db = createValidatedDb(schema, data); // validate first, then build (development and tests)

db.get(table, pk);            // O(1) through the PK Map index. Unavailable at the type level without a PK
db.get(table, [a, b]);        // a composite PK is passed as a tuple, in the declared order
db.getOrThrow(table, pk);
db.getBy(table.col, value);   // unique columns only, enforced at compile time and at runtime
db.all(table);                // with defaultOrder applied (cached)
db.rowsOf(table);             // the raw rows, in insertion order
db.count(table);
```

### The select builder

```ts
db.select(projection?)        // projection: column reference or expression -> value / table -> whole row
  .from(source)               // a table or an unnest()
  .innerJoin(table, on) / .leftJoin(table, on)
  .where(condition)           // repeated calls are ANDed
  .orderBy(desc(col, { nulls: "last" }), col2)  // a bare expression means implicit asc
  .limit(n)
  .distinctBy((row) => key)   // applies to the projected rows
  .all() / .first() / .firstOrThrow() / .count() / .countBy((row) => key)
```

Operators: `eq ne gt gte lt lte inArray notInArray isNull isNotNull and or not`, plus `some` (an element predicate) and `arrayContains` (containment in a scalar array) for arrays.

```ts
// A reverse lookup through a nested array
db.select().from(songs).where(some(songs.artists, (a) => eq(a.id, artistId))).all();

// Nest some for double nesting
db.select().from(videos).where(
  some(videos.coveredEvents, (ce) => some(ce.tracks, (tr) => eq(tr.songId, songId))),
).all();
```

### unnest and join

`unnest()` expands a top-level array column into a virtual table of one row per element (the equivalent of SQL's unnest).

```ts
const item = unnest(schema.setlists.items);
// item.songId ... an expression for an element field
// item.$parent.liveEventId ... a column reference on the parent row (the parent table itself can also be projected)
// item.$index / item.$ ... the position within the array / the whole element

// A multi-step join: song -> setlist -> event -> tour
db.select({ live: schema.lives, event: schema.events })
  .from(item)
  .where(eq(item.songId, songId))
  .innerJoin(schema.events, eq(item.$parent.liveEventId, schema.events.id))
  .innerJoin(schema.lives, eq(schema.events.liveId, schema.lives.id))
  .distinctBy((r) => r.live.id)
  .all();

// An aggregation: how many events played each song (repeats within one event count once)
db.select({ songId: item.songId, eventId: item.$parent.liveEventId })
  .from(item)
  .distinctBy((r) => `${r.songId}:${r.eventId}`)
  .countBy((r) => r.songId);   // Map<string, number>
```

- When a join's `on` is an eq of the form "a column of the joined table = an outer expression" it becomes a hash join; anything else is a nested loop
- Joining without a projection produces a keyed result of `{ [table name]: row }`. An unmatched `leftJoin` yields `null`
- **Deliberate type compromises in v1** (the same trade-off Drizzle makes):
  - Whether a column in a where clause or a projection belongs to a joined source is not type-checked (it fails immediately at runtime with a specific message)
  - `leftJoin` only adds `| null` to whole-table projection entries; individual column projections are not made nullable
  - A join whose source is an `unnest` requires a projection

## Node helpers (steledb/node)

```ts
import { loadTablesFromDir, runIntegrityCheck } from "steledb/node";

// Load every table of the schema from a JSON directory
const data = await loadTablesFromDir(new URL("../src/data/", import.meta.url), schema, {
  fileFor: (key) => `${key === "digitalSingles" ? "digital-singles" : key}.json`,
});
```

A check script for CI takes four lines. Node 22.18+ runs TS directly, so tsx is unnecessary (note that the schema side is then limited to erasable syntax and cannot use path aliases).

```ts
// scripts/check-data.ts
import { runIntegrityCheck } from "steledb/node";
import { schema } from "../src/db/schema.ts";
await runIntegrityCheck({ schema, dataDir: new URL("../src/data/", import.meta.url) });
```

```jsonc
// package.json
{ "scripts": { "check:data": "node scripts/check-data.ts" } }
```

`runIntegrityCheck` lists every error and sets `process.exitCode = 1`; on success it prints a per-table row count summary.

## The CLI

The same check is available without a script of your own. The schema file is imported dynamically, so a `.ts` file works directly.

```bash
steledb check --schema src/db/schema.ts --data src/data/
steledb check --schema src/db/schema.ts --data src/data/ --json   # machine readable, for CI
```

```jsonc
// package.json
{ "scripts": { "check:data": "steledb check --schema src/db/schema.ts --data src/data/" } }
```

`--export <name>` selects the export holding the schema (it defaults to `schema`). The exit code is 0 on success, 1 on an integrity error, and 2 on a usage error.

## The studio

`steledb studio` opens a local GUI console over the same schema: a browser view of the data where every relationship the schema declares is navigable.

```bash
steledb studio --schema src/db/schema.ts --data src/data/
# steledb studio is running
#   http://127.0.0.1:4321/#t=1f0c…
#   9 tables · data integrity OK
```

Open the printed URL — it carries the session token in the fragment. `--open` launches the browser for you, `--port <n>` picks the port (4321 by default, falling back to a free one when it is taken), and `--read-only` serves the data without allowing edits.

What it gives you over opening the JSON files by hand:

- **Follow a foreign key.** Every FK cell is a link. Clicking it resolves the value and jumps to the row it points at, at any nesting depth — `tracks[].songId` links just like a top-level column does
- **See who points back.** Each row lists the rows referencing it, grouped by column and labelled with the path they come from (`coveredEvents[2].tracks[0].songId`). A row with no incoming references says so, which is the question you actually want answered before deleting anything
- **Integrity errors in place.** The same `validate()` that powers `steledb check` runs on load and after every save; offending cells are highlighted and the row panel lists the messages
- **Edit rows.** Scalar columns get a widget derived from the schema (enums become a select, nullable columns get a null toggle); arrays and objects are edited as JSON. Rows can be added, duplicated and deleted
- **Live reload.** The data directory is watched, so edits made in your editor show up without a refresh

Saved files stay reviewable. The indentation, trailing newline and key order of the original are preserved, and rows you did not touch are written back as the exact text they came from — so editing one cell produces a one-line diff, even in a file where records are hand-formatted onto a single line.

That only holds if nothing else reformats the files, so exclude the data directory from your formatter (Prettier, Biome, `editor.formatOnSave`). Otherwise a formatter run and a studio save will fight over the layout, and every commit carries noise.

Two things guard the write access: the server binds to `127.0.0.1` only, and every API call has to present a token generated at startup (a Host header check blocks DNS rebinding on top of that). Use `--read-only` when you only want to look.

It can also be started from code, which is the way to pass `fileFor` for kebab-case file names:

```ts
import { startStudio } from "steledb/studio";
import { schema } from "./src/db/schema.ts";

const studio = await startStudio({
  schema,
  dataDir: new URL("./src/data/", import.meta.url),
  fileFor: (key) => `${key === "digitalSingles" ? "digital-singles" : key}.json`,
});
console.log(studio.url);
// await studio.close();
```

## Migrating from a validation script

A validation script hard-coded against the data structure (one that walks, say, "does every artists[].id in songs exist in artists.json" by hand) maps onto schema declarations like this.

| Hard-coded check | The steledb declaration |
|---|---|
| duplicate id check | `.primaryKey()` / `.unique()` |
| duplicate combination of columns | `unique: [[self.a, self.b]]` (or `primaryKey: [self.a, self.b]`) in the table options |
| referenced id exists | `.references(() => master.id)` |
| redundant name agrees | `.mustMatch(() => master.name, { via: "id" })` |
| agreement allowing aliases | `mustMatch` plus `orIn: () => master.alias` |
| duplicate track number within a disc | `.uniqueBy((tr) => [tr.disc ?? 1, tr.no])` |
| any other rule | `checks` in the table options |

Every reference declared in the schema is validated automatically, which removes the whole category of "a reference somebody forgot to add to the validation script".

## Out of scope for v1

A write API / transactions / migrations, a SQL string parser, relation definitions (a `with`-style API), aggregation beyond count (use `Map.groupBy` or `reduce`), value format validation (regex / min / max — use `checks`), a CJS build, and i18n.

(The studio does write to the JSON files, but that is a development tool editing the source data — the query API itself stays read-only.)

## Development

```bash
npm run check   # lint + typecheck + build + test + the core node: import check + the example project
npm run test    # vitest (.test.ts and .test-d.ts)
npm run dev     # tsc --watch
```

- Runtime tests live in `src/*.test.ts`, type tests in `src/*.test-d.ts` (using `expectTypeOf`)
- `scripts/check-core-imports.mjs` verifies that no `node:` import has crept into the core (anything outside `src/node`, `src/cli` and `src/studio`)
- [`example/`](example/) is its own npm project depending on `steledb` via `file:..`, so it exercises the published entry points rather than relative imports. `npm run check:example` installs it and runs its typecheck, tests and `steledb check` — it needs `npm run build` to have run first, since a `file:` dependency does not run `prepare`
- The studio's front end is plain HTML / CSS / ES modules in `src/studio/assets/`, with no build step of its own; `scripts/copy-assets.mjs` copies it into `dist` because tsc only emits TypeScript

## License

MIT
