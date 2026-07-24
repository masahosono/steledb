/**
 * README の Quickstart と同じコード例。テストとして実行されるため、
 * README の例が腐っていないことを CI が保証する。
 * 実際の利用側では `../src/index.js` の代わりに `steledb` を import する。
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

// --- 1. スキーマ定義 -------------------------------------------------------

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
    // ネスト配列内の FK + 非正規化フィールドの一致検証
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

// 行型はスキーマから推論される（手書きの型定義は不要）
type Book = InferRow<typeof books>;

// --- 2. データ（実際は JSON ファイルを import / ロードする） ----------------

const data = {
  authors: [
    { id: "a1", name: "山田太郎" },
    { id: "a2", name: "佐藤花子" },
  ],
  books: [
    {
      id: "b1",
      slug: "first-book",
      title: "最初の本",
      publishedYear: 2020,
      credits: [{ authorId: "a1", authorName: "山田太郎" }],
      tags: ["技術", "入門"],
    },
    {
      id: "b2",
      slug: "second-book",
      title: "二冊目の本",
      publishedYear: 2024,
      credits: [
        { authorId: "a1", authorName: "山田太郎" },
        { authorId: "a2", authorName: "佐藤花子" },
      ],
      tags: ["技術"],
    },
  ],
  shelves: [
    {
      id: "sh1",
      owner: "masahiro",
      items: [
        { bookId: "b2", position: 1 },
        { bookId: "b1", position: 2, note: "積読" },
      ],
    },
  ],
};

describe("Quickstart", () => {
  // --- 3. 検証（CI で回す） ------------------------------------------------

  test("スキーマの全制約でデータを検証できる", () => {
    const result = validate(schema, data);
    expect(result.ok).toBe(true);

    // 壊れたデータは構造化エラーで全件列挙される
    const broken = structuredClone(data);
    broken.books[0]?.credits.push({ authorId: "a999", authorName: "誰?" });
    const failed = validate(schema, broken);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toMatchObject({
      code: "FK_VIOLATION",
      table: "books",
      rowLabel: '"最初の本" (b1)',
      pathString: "credits[1].authorId",
    });
  });

  // --- 4. クエリ -------------------------------------------------------------

  test("O(1) lookup と全件取得", () => {
    const db = createDb(schema, data);

    const book: Book | undefined = db.get(schema.books, "b1");
    expect(book?.title).toBe("最初の本");

    expect(db.getBy(schema.books.slug, "second-book")?.id).toBe("b2");

    // defaultOrder (publishedYear 降順) が適用される
    expect(db.all(schema.books).map((b) => b.id)).toEqual(["b2", "b1"]);
  });

  test("select ビルダー: where / 射影 / 逆参照", () => {
    const db = createDb(schema, data);

    // 著者 a2 が関わった本（ネスト配列の逆参照）
    const byAuthor = db
      .select({ id: schema.books.id, title: schema.books.title })
      .from(schema.books)
      .where(some(schema.books.credits, (credit) => eq(credit.authorId, "a2")))
      .all();
    expect(byAuthor).toEqual([{ id: "b2", title: "二冊目の本" }]);
  });

  test("unnest + join: 棚のアイテムを本と突き合わせる", () => {
    const db = createDb(schema, data);
    const item = unnest(schema.shelves.items);

    const rows = db
      .select({ owner: item.$parent.owner, position: item.position, book: schema.books })
      .from(item)
      .innerJoin(schema.books, eq(item.bookId, schema.books.id))
      .all();
    expect(rows).toEqual([
      { owner: "masahiro", position: 1, book: data.books[1] },
      { owner: "masahiro", position: 2, book: data.books[0] },
    ]);
  });
});
