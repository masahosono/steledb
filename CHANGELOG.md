# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0, a minor bump may carry a breaking change to the public API.

## [Unreleased]

The first release. steledb treats a set of JSON files as a static relational database, deriving both integrity validation and TypeScript row types from one schema definition.

### Added

- **Schema DSL** — Drizzle-style `table()` and `defineSchema()`, with column builders (`t.string`, `t.number`, `t.boolean`, `t.enum`, `t.array`, `t.object`) and the modifiers `primaryKey`, `unique`, `nullable`, `optional`, `references`, `mustMatch`, `uniqueBy` and `displayAs`. Schemas are frozen and their constraints resolved at definition time, so a mistake in the schema throws where it is written rather than where it is used
- **Row type inference** — `InferRow` derives the TypeScript type of a row from the schema, so the data structure is declared once
- **Integrity validation** — `validate()` covers shape mismatches, unknown keys, primary keys, single-column and table-level composite uniqueness, foreign keys (including inside nested arrays, doubly nested arrays and scalar arrays), denormalized field agreement via `mustMatch` (with alias support), scoped composite uniqueness via `uniqueBy`, and custom row-level `checks`
- **Structured errors** — every violation carries the table, row index, primary key, display label, exact path and a discriminated `code`, as data rather than a formatted string, so it can be fed directly into an automated editing workflow. `formatErrors()` renders the human-readable form for a terminal
- **Typed query API** — `createDb()` / `createValidatedDb()`, O(1) `get` and `getBy` lookups, `all`, `count`, and a select builder with `where`, projection, `orderBy`, `limit` and `offset`. `unnest` flattens nested arrays and inner / left joins run over a hash join. Everything is synchronous and terminal methods return plain arrays
- **Expression helpers** — `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `inArray`, `notInArray`, `isNull`, `isNotNull`, `arrayContains`, `some`, `asc` and `desc`
- **Composite keys** — `primaryKey` and `unique` declared at the table level across several columns
- **`steledb/node`** — `loadTablesFromDir()` and `runIntegrityCheck()`, behind a separate entry point so the core stays free of `node:` imports and bundles for environments without a filesystem
- **`steledb check`** — a CLI integrity gate for CI, with `--json` output and distinct exit codes for an integrity error (1) and a usage error (2)
- **`steledb studio`** — a local GUI console over the data: navigate foreign keys in both directions at any nesting depth, see incoming references per row, view integrity errors in place, and edit rows with widgets derived from the schema. Saves preserve the original indentation, key order and untouched rows verbatim, so editing one cell produces a one-line diff. Bound to `127.0.0.1` with a per-run token and a `Host` header check; `--read-only` serves without write access
- Documentation in English ([README.md](README.md)) and Japanese ([README.ja.md](README.ja.md)), plus a runnable example project under [`example/`](example/) whose tests double as the Quickstart

[unreleased]: https://github.com/masahosono/steledb/commits/main
