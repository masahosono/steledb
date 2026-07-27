/**
 * The schema. Written once, it produces both the validation rules and the row
 * types — nothing about the data structure is repeated anywhere else.
 *
 * This is the same definition as the Quickstart in the README.
 */
import { type InferRow, defineSchema, desc, t, table } from "steledb";

export const authors = table("authors", {
  id: t.string().primaryKey(),
  name: t.string(),
});

export const books = table(
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

export const shelves = table("shelves", {
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

const tables = { authors, books, shelves };

export const schema = defineSchema(tables);

/** The table set behind the schema, for typing a Db that holds it. */
export type CatalogTables = typeof tables;

// Row types are inferred from the schema (no hand-written type definitions)
export type Author = InferRow<typeof authors>;
export type Book = InferRow<typeof books>;
export type Shelf = InferRow<typeof shelves>;
