/**
 * The schema. Written once, it produces both the validation rules and the row
 * types — nothing about the data structure is repeated anywhere else.
 *
 * This is the same definition as the Quickstart in the README.
 */
import { type InferRow, defineSchema, desc, t, table } from "steledb";

export const authors = table("authors", {
  id: t.string().primaryKey(),
  // Deliberately not unique: two authors are allowed to share a name
  name: t.string(),
});

export const awards = table("awards", {
  id: t.string().primaryKey(),
  // An award name, unlike a person's name, really is one of a kind
  name: t.string().unique(),
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
    // The same award cannot be won twice in one year. One year can still bring
    // several awards, and one award can come back in a later year, so neither
    // half of the key would do on its own
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

const tables = { authors, awards, books };

export const schema = defineSchema(tables);

/** The table set behind the schema, for typing a Db that holds it. */
export type CatalogTables = typeof tables;

// Row types are inferred from the schema (no hand-written type definitions)
export type Author = InferRow<typeof authors>;
export type Award = InferRow<typeof awards>;
export type Book = InferRow<typeof books>;
