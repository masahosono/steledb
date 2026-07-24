/**
 * The same code as the Quickstart in the README. It runs as a test, so CI
 * guarantees the README example has not gone stale.
 * A real consumer imports `steledb` instead of `../src/index.js`.
 */
import { describe, expect, test } from "vitest";
import {
  type InferRow,
  createDb,
  defineSchema,
  desc,
  eq,
  some,
  t,
  table,
  unnest,
  validate,
} from "../src/index.js";

// --- 1. Define the schema --------------------------------------------------

const authors = table("authors", {
  id: t.string().primaryKey(),
  name: t.string(),
});

const books = table(
  "books",
  {
    id: t.string().primaryKey(),
    slug: t.string().unique(),
    title: t.string(),
    publishedYear: t.number().nullable(),
    // An FK inside a nested array, plus a check on a denormalized field
    credits: t.array(
      t.object({
        authorId: t.string().references(() => authors.id),
        authorName: t.string().mustMatch(() => authors.name, { via: "authorId" }),
      }),
    ),
    tags: t.array(t.string()),
  },
  (self) => ({
    defaultOrder: [desc(self.publishedYear, { nulls: "last" })],
    displayAs: (row) => `"${row.title}" (${row.id})`,
  }),
);

const shelves = table("shelves", {
  id: t.string().primaryKey(),
  owner: t.string(),
  items: t
    .array(
      t.object({
        bookId: t.string().references(() => books.id),
        position: t.number(),
        note: t.string().optional(),
      }),
    )
    .uniqueBy((item) => item.position),
});

const schema = defineSchema({ authors, books, shelves });

// Row types are inferred from the schema (no hand-written type definitions)
type Book = InferRow<typeof books>;

// --- 2. The data (in practice, imported or loaded from JSON files) ---------

const data = {
  authors: [
    { id: "a1", name: "Ada Lowell" },
    { id: "a2", name: "Maya Iverson" },
  ],
  books: [
    {
      id: "b1",
      slug: "first-book",
      title: "The First Book",
      publishedYear: 2020,
      credits: [{ authorId: "a1", authorName: "Ada Lowell" }],
      tags: ["tech", "beginner"],
    },
    {
      id: "b2",
      slug: "second-book",
      title: "The Second Book",
      publishedYear: 2024,
      credits: [
        { authorId: "a1", authorName: "Ada Lowell" },
        { authorId: "a2", authorName: "Maya Iverson" },
      ],
      tags: ["tech"],
    },
  ],
  shelves: [
    {
      id: "sh1",
      owner: "alex",
      items: [
        { bookId: "b2", position: 1 },
        { bookId: "b1", position: 2, note: "unread" },
      ],
    },
  ],
};

describe("Quickstart", () => {
  // --- 3. Validation (run this in CI) --------------------------------------

  test("validates data against every constraint in the schema", () => {
    const result = validate(schema, data);
    expect(result.ok).toBe(true);

    // Broken data is listed in full as structured errors
    const broken = structuredClone(data);
    broken.books[0]?.credits.push({ authorId: "a999", authorName: "Who?" });
    const failed = validate(schema, broken);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({
      code: "FK_VIOLATION",
      table: "books",
      rowLabel: '"The First Book" (b1)',
      pathString: "credits[1].authorId",
    });
  });

  // --- 4. Queries -------------------------------------------------------------

  test("O(1) lookups and fetching everything", () => {
    const db = createDb(schema, data);

    const book: Book | undefined = db.get(schema.books, "b1");
    expect(book?.title).toBe("The First Book");

    expect(db.getBy(schema.books.slug, "second-book")?.id).toBe("b2");

    // defaultOrder (publishedYear descending) applies
    expect(db.all(schema.books).map((b) => b.id)).toEqual(["b2", "b1"]);
  });

  test("the select builder: where, projection, reverse lookup", () => {
    const db = createDb(schema, data);

    // Books author a2 worked on (a reverse lookup through a nested array)
    const byAuthor = db
      .select({ id: schema.books.id, title: schema.books.title })
      .from(schema.books)
      .where(some(schema.books.credits, (credit) => eq(credit.authorId, "a2")))
      .all();
    expect(byAuthor).toEqual([{ id: "b2", title: "The Second Book" }]);
  });

  test("unnest plus join: matching shelf items against books", () => {
    const db = createDb(schema, data);
    const item = unnest(schema.shelves.items);

    const rows = db
      .select({ owner: item.$parent.owner, position: item.position, book: schema.books })
      .from(item)
      .innerJoin(schema.books, eq(item.bookId, schema.books.id))
      .all();
    expect(rows).toEqual([
      { owner: "alex", position: 1, book: data.books[1] },
      { owner: "alex", position: 2, book: data.books[0] },
    ]);
  });
});
