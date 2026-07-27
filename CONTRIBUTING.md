# Contributing to steledb

Thanks for taking an interest. Issues and pull requests are both welcome — a bug report with a minimal schema that reproduces it is as useful as a patch.

## Getting set up

```bash
git clone https://github.com/masahosono/steledb.git
cd steledb
npm install
npm run build   # required before the example project can resolve steledb
```

Node.js 22.18.0 or newer. The repository pins a version in `mise.toml`, so [mise](https://mise.jdx.dev/) users get it with `mise install`.

## The one gate

```bash
npm run check
```

That is lint + typecheck + build + test + the core `node:` import check + the example project, and it is exactly what CI runs on Node 22.18.0, 24 and 26. If it passes locally it will pass on CI.

The individual pieces, for a tighter loop:

```bash
npm run lint         # biome check .
npm run format       # biome format --write .
npm run typecheck    # tsc --noEmit
npm run test         # vitest, both .test.ts and .test-d.ts
npm run test:watch
npm run dev          # tsc --watch
```

## Tests

Two kinds live side by side, and a change to the type-level API needs both:

- **`src/*.test.ts`** — runtime behaviour, under vitest
- **`src/*.test-d.ts`** — type-level behaviour, using `expectTypeOf`. These are real tests: much of what this library promises is inference, so a change that keeps the runtime correct while degrading the inferred row type is a regression

`src/testing/catalog-schema.ts` is a kitchen-sink schema covering every constraint pattern in as few rows as possible. Prefer extending it over building a new fixture, and keep it excluded from the build (`tsconfig.build.json` already does).

## Two architectural rules

**The core stays free of `node:`.** Everything outside `src/node`, `src/cli` and `src/studio` has to bundle for environments without a filesystem, such as Cloudflare Workers. `scripts/check-core-imports.mjs` enforces this and `npm run check` runs it, so a stray `import { readFile } from "node:fs"` in `src/validate.ts` fails the build rather than quietly breaking a downstream bundle. Filesystem work belongs behind the `steledb/node` entry point.

**The studio's front end has no build step.** `src/studio/assets/` is plain HTML, CSS and ES modules loaded directly by the browser. `scripts/copy-assets.mjs` copies the directory into `dist` unchanged, keeping the layout identical on both sides — that is what lets `server.ts` resolve it with `new URL("./assets/", import.meta.url)` whether it runs from `src` (tests) or from `dist` (the published package). Please don't introduce a bundler for it.

## What ships

`files: ["dist"]` decides the published package, and `tsconfig.build.json` deliberately emits no source maps. They would resolve to `src/`, which is not published, so `.js.map` and `.d.ts.map` would cost 45% of the tarball to point at nothing. Validation failures are reported as structured data — table, row index, path and an error code — rather than through a stack trace, so there is little to step through. If debugging into the library is ever asked for, turn `sourceMap` back on together with `inlineSources` so the maps stay self-contained.

## The example project

[`example/`](example/) is its own npm project depending on `steledb` via `file:..`, so it imports by package name and exercises the published entry points rather than relative paths. `npm run check:example` installs it and runs its typecheck, tests and `steledb check`.

It needs `npm run build` to have run first: a `file:` dependency does not run `prepare`.

Its `src/index.test.ts` doubles as the README's Quickstart. If you change the code in the README, change it there too so the test keeps it honest.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:` — written in the imperative and describing the change, not the file touched.

Before opening a PR:

1. `npm run check` passes
2. Behaviour changes come with a test; type-level changes come with a `.test-d.ts` case
3. User-facing changes are reflected in **both** `README.md` and `README.ja.md`

For anything that changes the public API or the schema DSL, opening an issue first saves us both time.

## Releasing

Maintainers only:

1. `npm version <patch|minor|major>`
2. Push the commit and the tag — `git push --follow-tags`
3. Write the notes for that tag on [GitHub Releases](https://github.com/masahosono/steledb/releases)

The `Release` workflow runs `npm run check` and then publishes to npm with provenance. Nothing publishes from a laptop.

There is no checked-in changelog: release notes live on GitHub Releases, where they sit next to the tag and the diff they describe. Until 1.0, a minor bump may carry a breaking change to the public API, so call those out at the top of the notes.
