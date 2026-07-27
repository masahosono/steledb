/**
 * The data layer of the example application.
 *
 * The pattern it demonstrates: load the JSON once into an in-memory database,
 * then express every query against the schema rather than against hand-written
 * types. The query functions take the Db explicitly, which keeps them pure and
 * testable — nothing here reaches for module-level state.
 */
import {
  type Db,
  type ValidationResult,
  createDb,
  createValidatedDb,
  eq,
  some,
  unnest,
  validate,
} from "steledb";
import { loadTablesFromDir } from "steledb/node";
import { type Award, type Book, type CatalogTables, schema } from "./db/schema.js";

/** Where the JSON tables live. One file per table, named after the schema key. */
export const DATA_DIR = new URL("./data/", import.meta.url);

/** An in-memory database holding this schema. */
export type CatalogDb = Db<CatalogTables>;

export interface LoadOptions {
  readonly dataDir?: URL | string;
  /**
   * Validate before building the database, throwing on any integrity error.
   * Defaults to true. Turn it off in production, where CI has already run
   * `steledb check` and the extra pass is wasted work.
   */
  readonly validate?: boolean;
}

/** Reads every table from disk and returns a database ready to query. */
export async function loadCatalog(options: LoadOptions = {}): Promise<CatalogDb> {
  const data = await loadTablesFromDir(options.dataDir ?? DATA_DIR, schema);
  return options.validate === false ? createDb(schema, data) : createValidatedDb(schema, data);
}

/** Runs the integrity check without building a database — this is what CI needs. */
export async function checkIntegrity(dataDir: URL | string = DATA_DIR): Promise<ValidationResult> {
  const data = await loadTablesFromDir(dataDir, schema);
  return validate(schema, data);
}

// --- Lookups ---------------------------------------------------------------

/** O(1) by primary key. */
export function book(db: CatalogDb, id: string): Book | undefined {
  return db.get(schema.books, id);
}

/** O(1) by a unique column other than the key. */
export function bookBySlug(db: CatalogDb, slug: string): Book | undefined {
  return db.getBy(schema.books.slug, slug);
}

/** Every book, newest first — the defaultOrder declared on the table. */
export function booksNewestFirst(db: CatalogDb): readonly Book[] {
  return db.all(schema.books);
}

// --- Queries ---------------------------------------------------------------

/**
 * The books an author is credited on. credits is a nested array, so this is a
 * reverse lookup: `some` asks whether any element of the array matches.
 */
export function booksByAuthor(db: CatalogDb, authorId: string): { id: string; title: string }[] {
  return db
    .select({ id: schema.books.id, title: schema.books.title })
    .from(schema.books)
    .where(some(schema.books.credits, (credit) => eq(credit.authorId, authorId)))
    .all();
}

export interface AwardWin {
  readonly year: number;
  readonly citation: string | undefined;
  readonly award: Award;
}

/**
 * What a book has won, oldest first. `unnest` turns the nested awards array
 * into rows, and the join resolves each entry's awardId against the masters.
 */
export function bookAwards(db: CatalogDb, bookId: string): AwardWin[] {
  const win = unnest(schema.books.awards);
  return db
    .select({ year: win.year, citation: win.citation, award: schema.awards })
    .from(win)
    .where(eq(win.$parent.id, bookId))
    .innerJoin(schema.awards, eq(win.awardId, schema.awards.id))
    .orderBy(win.year)
    .all();
}

export interface AwardWinner {
  readonly year: number;
  readonly bookId: string;
  readonly title: string;
}

/**
 * The other direction: what has won a given award. No join this time — the
 * unnested rows reach their own row's columns through `$parent`.
 */
export function awardWinners(db: CatalogDb, awardId: string): AwardWinner[] {
  const win = unnest(schema.books.awards);
  return db
    .select({ year: win.year, bookId: win.$parent.id, title: win.$parent.title })
    .from(win)
    .where(eq(win.awardId, awardId))
    .orderBy(win.year)
    .all();
}

/**
 * Books grouped by tag. Aggregation beyond count is deliberately outside the
 * query API, so it is plain JavaScript over the rows.
 */
export function booksByTag(db: CatalogDb): Map<string, Book[]> {
  const grouped = new Map<string, Book[]>();
  for (const entry of db.all(schema.books)) {
    for (const tag of entry.tags) {
      const bucket = grouped.get(tag);
      if (bucket === undefined) grouped.set(tag, [entry]);
      else bucket.push(entry);
    }
  }
  return grouped;
}

/**
 * The authors credited on a book. No join is needed: each credit already
 * carries the author's name, and mustMatch guarantees that copy agrees with the
 * authors table — which is the whole point of declaring a denormalized field.
 */
export function creditedAuthors(db: CatalogDb, bookId: string): { id: string; name: string }[] {
  const found = book(db, bookId);
  if (found === undefined) return [];
  return found.credits.map((credit) => ({ id: credit.authorId, name: credit.authorName }));
}

export { schema } from "./db/schema.js";
export type { Author, Award, Book } from "./db/schema.js";
