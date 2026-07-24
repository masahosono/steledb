# steledb

JSON ファイル群を静的 RDB として扱う TypeScript ライブラリ。

Git 管理された静的データ（1 JSON ファイル = 1 テーブルのレコード配列）に対して、Drizzle 風のスキーマ定義から次の 2 つを提供します。

1. **リレーショナル整合性検証** — PK / unique / FK（ネスト配列・2 重ネスト・スカラー配列を含む）/ 非正規化フィールドの一致検証 / スコープ付き複合 unique / カスタム検証
2. **型付きクエリ API** — O(1) lookup / select ビルダー（where・射影・orderBy）/ ネスト配列の unnest / join / 集計

スキーマを 1 箇所に書けば、検証ロジックと TypeScript の行型がそこから導出されます。データ構造の変更にはスキーマの修正だけで追従でき、検証スクリプトへのハードコードが不要になります。AI がデータファイルを編集するワークフローでは、未知キーの検出を含む検証がゲートとして機能します。

## 特徴

- **コアはランタイム依存ゼロ・fs 非依存・ESM only**。データは parse 済み配列の注入式なので、Cloudflare Workers など fs を持たない環境にそのままバンドルできます
- **完全同期 API**。データはインメモリなので Promise を返しません。終端メソッドは素の配列を返すため、ネイティブ配列メソッドが常にエスケープハッチになります
- **Node ヘルパーは別エントリポイント** (`steledb/node`)。fs からのロードと CI 用検証ランナーを提供します

## インストール

npm には公開していないため、`file:` 参照で利用します。

```jsonc
// 利用側の package.json
{
  "dependencies": {
    "steledb": "file:../steledb"
  }
}
```

steledb 側でビルドが必要です（`file:` 参照では prepare が走りません）。

```bash
cd steledb && npm install && npm run build   # 開発中は npm run dev で watch
```

Vite / Astro から使う場合、事前バンドルで symlink が壊れるときは `optimizeDeps.exclude: ["steledb"]` を設定してください。

## Quickstart

コード例の完全版は [`examples/quickstart.test.ts`](examples/quickstart.test.ts) にあり、テストとして常に実行されています。

### 1. スキーマ定義

```ts
import { defineSchema, desc, t, table, type InferRow } from "steledb";

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

export const schema = defineSchema({ authors, books });

type Book = InferRow<typeof books>; // 行型は推論で導出（手書き型は不要）
```

`defineSchema()` はスキーマの凍結処理を行い、参照先の存在・FK 参照先の unique 性・`via` 兄弟の存在・PK の単一性などを **この時点でランタイム検証** します。壊れたスキーマは import した瞬間に落ちます。

### 2. 検証

```ts
import { formatErrors, validate } from "steledb";

const result = validate(schema, { authors, books }); // データは Record<スキーマキー, unknown[]>
if (!result.ok) {
  console.error(formatErrors(result.errors)); // 人間可読な全件列挙
  // result.errors は構造化データ（code / table / rowLabel / path / pathString ...）
}
```

### 3. クエリ

```ts
import { createDb, eq, some, unnest } from "steledb";

const db = createDb(schema, data); // 検証はしない（CI で validate 済みの前提）

db.get(schema.books, "b1");                  // PK で O(1) → Book | undefined
db.getBy(schema.books.slug, "second-book");  // unique カラムで O(1)
db.all(schema.books);                        // defaultOrder 適用済みの全件

// select ビルダー: 射影から戻り値型が推論される
db.select({ id: schema.books.id, title: schema.books.title })
  .from(schema.books)
  .where(some(schema.books.credits, (credit) => eq(credit.authorId, "a2")))
  .all(); // { id: string; title: string }[]
```

## スキーマ DSL リファレンス

### カラム型と修飾

| ビルダー | 行型 |
|---|---|
| `t.string()` / `t.number()` / `t.boolean()` | `string` / `number` / `boolean` |
| `t.enum("a", "b")` | `"a" \| "b"`（リテラルユニオン） |
| `t.array(inner)` | `Inner[]` |
| `t.object({ ... })` | ネストオブジェクト |
| `.nullable()` | `T \| null` |
| `.optional()` | `key?: T`（JSON にキー自体が無くてよい） |
| `.primaryKey()` | PK。unique を含意。1 テーブル 1 カラム |
| `.unique()` | テーブル全体で重複禁止（null は複数可） |

`optional` は「キー欠落」のみを意味します（JSON に undefined は存在しないため）。PK を持たないテーブルでは実質 PK のカラム（例: `setlists.liveEventId`）に `.primaryKey()` を付けてください。

### 参照制約

```ts
// 外部キー。thunk 形式が基本（リファクタリング安全）
liveId: t.string().nullable().references(() => lives.id),

// 循環参照などで型が組めない場合の文字列形式フォールバック
liveId: t.string().references("lives", "id"),

// スカラー配列 FK / ネスト配列内 FK / 2 重ネスト FK も同じ書き方
coveredLiveIds: t.array(t.string().references(() => lives.id)),
```

FK の参照先は `primaryKey` か `unique` のカラムである必要があります。null / キー欠落の値は検証対象外です（nullable FK / optional FK）。

### 非正規化フィールドの一致検証（mustMatch）

参照先の name などを冗長に持つフィールドの検証。同一オブジェクトスコープ内の FK フィールド名を `via` で指定し、マスタ行と突き合わせます。

```ts
// 厳密一致: artists[].name はマスタの name と完全一致必須
name: t.string().mustMatch(() => artists.name, { via: "id" }),

// alias 許容: venue は venues.name と一致、または venues.alias[] に含まれれば OK
venue: t.string().nullable().mustMatch(() => venues.name, {
  via: "venueId",
  orIn: () => venues.alias,
}),

// 検証なし = 宣言しない（盤面表記など表記ゆれを許容するフィールド）
```

### スコープ付き複合 unique（uniqueBy）

親レコード内の配列に対する重複禁止。キー抽出関数なのでデフォルト値も自然に書けます。

```ts
tracks: t.array(trackShape).uniqueBy((track) => [track.disc ?? 1, track.no]),
```

### テーブルオプション

```ts
table("events", { ... }, (self) => ({
  defaultOrder: [desc(self.eventDate)],          // db.all() / select の既定ソート
  displayAs: (row) => `"${row.name}" (${row.id})`, // 検証エラーの行特定表示
  checks: [(row) => (row.endDate >= row.startDate ? null : "endDate が startDate より前です")],
}));
```

## 検証

```ts
const result = validate(schema, data, { unknownKeys: "error" }); // デフォルト "error"
```

検証順: **shape**（型・enum・nullable/optional 違反・未知キー）→ **PK/unique 重複** → **FK 存在** → **mustMatch** → **uniqueBy** → **checks**。fail-fast せず全件収集し、shape が壊れた行は関係検証をスキップしてノイズを抑えます。

エラーは判別可能ユニオンの構造化データです。

```ts
type ValidationError = {
  table: string;            // スキーマキー
  rowIndex: number;
  rowKey: string | number | null;   // PK 値
  rowLabel: string;         // displayAs の結果
  path: (string | number)[];        // ["coveredEvents", 0, "tracks", 3, "songId"]
  pathString: string;       // "coveredEvents[0].tracks[3].songId"
  message: string;
} & (
  | { code: "SHAPE_MISMATCH"; expected: string; actual: unknown }
  | { code: "UNKNOWN_KEY"; key: string }
  | { code: "DUPLICATE_KEY"; column: string; value: unknown; otherRowIndex: number }
  | { code: "FK_VIOLATION"; value: unknown; refTable: string; refColumn: string }
  | { code: "DENORMALIZED_MISMATCH"; actual: unknown; expected: unknown;
      allowedAliases?: unknown[]; refTable: string; refKeyPath: string }
  | { code: "SCOPED_DUPLICATE"; scopePath: string; key: unknown[] }
  | { code: "CHECK_FAILED"; detail: string }
);
```

## クエリ

### 基本

```ts
const db = createDb(schema, data);       // データは信頼して保持（ゼロコスト）
const db = createValidatedDb(schema, data); // validate してから構築（開発・テスト用）

db.get(table, pk);            // PK Map インデックスで O(1)。PK 未宣言テーブルは型レベルで不可
db.getOrThrow(table, pk);
db.getBy(table.col, value);   // unique カラムのみコンパイル・実行時とも許可
db.all(table);                // defaultOrder 適用済み（キャッシュされる）
db.rowsOf(table);             // 注入順の生データ
db.count(table);
```

### select ビルダー

```ts
db.select(projection?)        // 射影: カラム参照・式 → 評価値 / テーブル実体 → 行丸ごと
  .from(source)               // テーブル or unnest()
  .innerJoin(table, on) / .leftJoin(table, on)
  .where(condition)           // 複数回で AND
  .orderBy(desc(col, { nulls: "last" }), col2)  // 式を直接渡すと暗黙 asc
  .limit(n)
  .distinctBy((row) => key)   // 射影後の行に効く
  .all() / .first() / .firstOrThrow() / .count() / .countBy((row) => key)
```

演算子: `eq ne gt gte lt lte inArray notInArray isNull isNotNull and or not` と配列用の `some`（要素述語）/ `arrayContains`（スカラー配列の包含）。

```ts
// ネスト配列の逆参照
db.select().from(songs).where(some(songs.artists, (a) => eq(a.id, artistId))).all();

// 2 重ネストは some をネストする
db.select().from(videos).where(
  some(videos.coveredEvents, (ce) => some(ce.tracks, (tr) => eq(tr.songId, songId))),
).all();
```

### unnest と join

`unnest()` はトップレベルの配列カラムを「1 要素 = 1 行」の仮想テーブルに展開します（SQL の unnest 相当）。

```ts
const item = unnest(schema.setlists.items);
// item.songId ... 要素フィールドの式
// item.$parent.liveEventId ... 親行のカラム参照（親テーブル自体を射影に置くことも可能）
// item.$index / item.$ ... 配列内位置 / 要素全体

// 多段 join: 曲 → セットリスト → 公演 → ライブ
db.select({ live: schema.lives, event: schema.events })
  .from(item)
  .where(eq(item.songId, songId))
  .innerJoin(schema.events, eq(item.$parent.liveEventId, schema.events.id))
  .innerJoin(schema.lives, eq(schema.events.liveId, schema.lives.id))
  .distinctBy((r) => r.live.id)
  .all();

// 集計: 曲ごとの公演回数（同一公演内の重複歌唱は 1 と数える）
db.select({ songId: item.songId, eventId: item.$parent.liveEventId })
  .from(item)
  .distinctBy((r) => `${r.songId}:${r.eventId}`)
  .countBy((r) => r.songId);   // Map<string, number>
```

- join の `on` が「join 先テーブルのカラム = 外側の式」の eq ならハッシュ結合、それ以外はネストループです
- 射影なしで join すると `{ [テーブル名]: 行 }` のキー付き結果になります。`leftJoin` のミスマッチは `null`
- **v1 の意図的な型妥協**（Drizzle と同じ割り切り）:
  - where / 射影のカラムが join 済みソースに属するかは型検査しません（実行時に具体的なメッセージで即エラー）
  - `leftJoin` の `| null` 化は「テーブル丸ごと射影」エントリのみ。個別カラム射影は nullable 化されません
  - `unnest` をソースにした join では射影が必須です

## Node ヘルパー（steledb/node）

```ts
import { loadTablesFromDir, runIntegrityCheck } from "steledb/node";

// JSON ディレクトリからスキーマの全テーブルをロード
const data = await loadTablesFromDir(new URL("../src/data/", import.meta.url), schema, {
  fileFor: (key) => `${key === "digitalSingles" ? "digital-singles" : key}.json`,
});
```

CI 用の check スクリプトは 4 行で書けます。Node 22.18+ は TS を直接実行できるため tsx は不要です（スキーマ側はパスエイリアス不可・erasable syntax のみの制約に注意）。

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

`runIntegrityCheck` はエラーを全件列挙して `process.exitCode = 1` を設定し、正常時はテーブル別件数サマリを出力します。

## 検証スクリプトからの移行

データ構造にハードコードされた検証スクリプト（例: 「songs の artists[].id が artists.json に存在するか」を手書きで回すもの）は、次の対応でスキーマ宣言に置き換えられます。

| ハードコード検証 | steledb での宣言 |
|---|---|
| id 重複チェック | `.primaryKey()` / `.unique()` |
| 参照 id の存在チェック | `.references(() => master.id)` |
| 冗長 name の一致チェック | `.mustMatch(() => master.name, { via: "id" })` |
| 別名許容の一致チェック | `mustMatch` + `orIn: () => master.alias` |
| ディスク内トラック番号の重複 | `.uniqueBy((tr) => [tr.disc ?? 1, tr.no])` |
| 上記以外の任意ルール | テーブルオプションの `checks` |

スキーマに宣言した参照はすべて自動で検証対象になるため、「検証スクリプトに追記し忘れた参照」がなくなります。

## v1 スコープ外

書き込み API / トランザクション / マイグレーション、SQL 文字列パーサー、リレーション定義（`with` 風 API）、count 以外の集計（`Map.groupBy` / `reduce` で代替）、bin CLI、値フォーマット検証（regex / min / max — `checks` で代替）、CJS ビルド、i18n。

## 開発

```bash
npm run check   # lint + typecheck + test（型テスト含む）+ build + コアの node: import 混入検査
npm run test    # vitest（.test.ts と .test-d.ts）
npm run dev     # tsc --watch
```

- ランタイムテストは `src/*.test.ts`、型テストは `src/*.test-d.ts`（`expectTypeOf`）
- コア（`src/node` 以外）に `node:` import が混入していないことを `scripts/check-core-imports.mjs` が検査します

## License

MIT
