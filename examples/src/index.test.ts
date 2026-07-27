/**
 * Tests for the data layer in index.ts. Together they also cover the Quickstart
 * in the README, so CI catches the example going stale.
 */
import { validate } from "steledb";
import { describe, expect, test } from "vitest";
import {
  type Author,
  type Book,
  type Shelf,
  book,
  bookBySlug,
  booksByAuthor,
  booksByTag,
  booksNewestFirst,
  checkIntegrity,
  creditedAuthors,
  loadCatalog,
  schema,
  shelfEntries,
} from "./index.js";

const db = await loadCatalog();

/**
 * A mutable, typed copy of the data — for the tests that break it on purpose.
 * rowsOf() rather than all(), so the rows keep their order in the file and the
 * row indexes in the reported errors line up with the JSON.
 */
function brokenData(): { authors: Author[]; books: Book[]; shelves: Shelf[] } {
  return {
    authors: structuredClone(db.rowsOf(schema.authors)) as Author[],
    books: structuredClone(db.rowsOf(schema.books)) as Book[],
    shelves: structuredClone(db.rowsOf(schema.shelves)) as Shelf[],
  };
}

describe("loading and validation", () => {
  test("loadCatalog validates by default, so a bad file would throw", async () => {
    // it already loaded at the top of this file without throwing
    expect(db.count(schema.books)).toBe(2);
    expect(db.count(schema.authors)).toBe(2);
    expect(db.count(schema.shelves)).toBe(1);
  });

  test("skipping validation is allowed for the CI-checked path", async () => {
    const fast = await loadCatalog({ validate: false });
    expect(fast.count(schema.books)).toBe(2);
  });

  test("checkIntegrity passes on the shipped data", async () => {
    const result = await checkIntegrity();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a dangling foreign key is reported with its exact location", () => {
    const data = brokenData();
    data.books[0]?.credits.push({ authorId: "a999", authorName: "Who?" });

    const failed = validate(schema, data);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({
      code: "FK_VIOLATION",
      table: "books",
      rowLabel: '"The First Book" (b1)',
      pathString: "credits[1].authorId",
    });
  });

  test("a denormalized field that drifted from its source is reported", () => {
    const data = brokenData();
    const credit = data.books[0]?.credits[0];
    if (credit !== undefined) credit.authorName = "Ada Lowells";

    const failed = validate(schema, data);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({
      code: "DENORMALIZED_MISMATCH",
      table: "books",
      pathString: "credits[0].authorName",
      actual: "Ada Lowells",
      expected: "Ada Lowell",
    });
  });

  test("a duplicate position within one shelf is reported", () => {
    const data = brokenData();
    const items = data.shelves[0]?.items;
    if (items?.[0] !== undefined) items[0].position = 2; // the second item already holds 2

    const failed = validate(schema, data);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({ code: "SCOPED_DUPLICATE", table: "shelves" });
  });
});

describe("lookups", () => {
  test("book() finds a row by primary key", () => {
    const found: Book | undefined = book(db, "b1");
    expect(found?.title).toBe("The First Book");
    expect(book(db, "nope")).toBeUndefined();
  });

  test("bookBySlug() finds a row by a unique column", () => {
    expect(bookBySlug(db, "second-book")?.id).toBe("b2");
    expect(bookBySlug(db, "no-such-slug")).toBeUndefined();
  });

  test("booksNewestFirst() applies the table's defaultOrder", () => {
    expect(booksNewestFirst(db).map((entry) => entry.id)).toEqual(["b2", "b1"]);
  });
});

describe("queries", () => {
  test("booksByAuthor() reverse-looks-up through a nested array", () => {
    expect(booksByAuthor(db, "a2")).toEqual([{ id: "b2", title: "The Second Book" }]);
    expect(booksByAuthor(db, "a1")).toEqual([
      { id: "b2", title: "The Second Book" },
      { id: "b1", title: "The First Book" },
    ]);
    expect(booksByAuthor(db, "a999")).toEqual([]);
  });

  test("shelfEntries() unnests the items and joins them against books", () => {
    const entries = shelfEntries(db, "sh1");
    expect(entries.map((entry) => [entry.position, entry.book.id, entry.note])).toEqual([
      [1, "b2", undefined],
      [2, "b1", "unread"],
    ]);
    // the joined value is the whole book row
    expect(entries[0]?.book).toEqual(book(db, "b2"));
  });

  test("shelfEntries() is empty for an unknown shelf", () => {
    expect(shelfEntries(db, "nope")).toEqual([]);
  });

  test("booksByTag() groups rows outside the query API", () => {
    const grouped = booksByTag(db);
    expect([...grouped.keys()].sort()).toEqual(["beginner", "tech"]);
    expect(grouped.get("tech")?.map((entry) => entry.id)).toEqual(["b2", "b1"]);
    expect(grouped.get("beginner")?.map((entry) => entry.id)).toEqual(["b1"]);
  });

  test("creditedAuthors() reads the denormalized names mustMatch keeps honest", () => {
    expect(creditedAuthors(db, "b2")).toEqual([
      { id: "a1", name: "Ada Lowell" },
      { id: "a2", name: "Maya Iverson" },
    ]);
    expect(creditedAuthors(db, "nope")).toEqual([]);
  });
});
