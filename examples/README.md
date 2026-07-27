# steledb example

A standalone project that consumes steledb the way a real one does: through a `file:` dependency, importing `steledb` and `steledb/node` by package name rather than by relative path.

```
examples/
└── src/
    ├── db/schema.ts     the schema — validation rules and row types come from here
    ├── data/*.json      one JSON file per table
    ├── index.ts         the data layer: loading, and one function per query
    └── index.test.ts    tests for it, which double as the README's Quickstart
```

## Running it

steledb has to be built first, because a `file:` dependency does not run `prepare`.

```bash
cd .. && npm install && npm run build
cd examples && npm install
```

Then:

```bash
npm test            # the data layer, and the Quickstart with it
npm run typecheck   # the row types are inferred from the schema, so this is a real check
npm run check:data  # steledb check — the CI integrity gate
npm run studio      # steledb studio — the GUI console, on this data
```

`npm run check` from the repository root runs all of this after building.

## What to look at

**`src/db/schema.ts`** — one definition produces the FK checks, the denormalized-field check (`mustMatch`), the scoped uniqueness rule (`uniqueBy`), the default ordering and every row type.

**`src/index.ts`** — the pattern worth copying: load the JSON once, then express each query as a function taking the `Db`. Nothing hand-writes a row type, and nothing walks the JSON by hand.

| Function | What it shows |
|---|---|
| `loadCatalog` | `loadTablesFromDir` plus `createValidatedDb` — and why production can skip the validation |
| `checkIntegrity` | the same check CI runs, as a library call |
| `book` / `bookBySlug` | O(1) lookups by primary key and by a unique column |
| `booksNewestFirst` | the `defaultOrder` declared on the table |
| `booksByAuthor` | a reverse lookup through a nested array, with `some` |
| `bookAwards` | `unnest` over a nested array, joined against the master table |
| `awardWinners` | the same array from the other side, reaching the owning row with `$parent` |
| `booksByTag` | aggregation, which is deliberately plain JavaScript |

**`npm run studio`** — open `books`, click the `authorId` inside a credit to jump to the author, then look at "Referenced by" on that author to see which books cite them.
