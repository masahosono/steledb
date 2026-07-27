# steledb

[![CI](https://github.com/masahosono/steledb/actions/workflows/ci.yml/badge.svg)](https://github.com/masahosono/steledb/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/steledb.svg)](https://www.npmjs.com/package/steledb)
[![license](https://img.shields.io/npm/l/steledb.svg)](LICENSE)

[English](README.md) | **日本語**

JSON ファイルの集まりを静的なリレーショナルデータベースとして扱う TypeScript ライブラリ。

バージョン管理された静的データ（1 つの JSON ファイルが 1 テーブル分のレコード配列を持つ形）に対して、Drizzle 風のスキーマ定義から次の 2 つが得られる。

1. **リレーショナル整合性チェック** — PK / ユニーク（単一カラムと複合の両方）/ FK（ネストした配列、二重ネスト、スカラー配列を含む）/ 非正規化フィールドの一致 / スコープ付き複合ユニーク / カスタムチェック
2. **型付きクエリ API** — O(1) ルックアップ / select ビルダー（where、射影、orderBy）/ ネストした配列に対する unnest / join / 集計

スキーマを一度書けば、検証ロジックと TypeScript の行の型がどちらもそこから導かれる。データ構造が変わったときに必要なのはスキーマの変更だけで、検証スクリプトに何かをハードコードすることはない。AI がデータファイルを編集するワークフローでは、未知のキーの検出を含めた検証がそのゲートとして働く。

## 特徴

- **コアはランタイム依存ゼロ、ファイルシステムに触らず、ESM のみ。** データはパース済みの配列として注入するので、Cloudflare Workers のようなファイルシステムのない環境にもそのままバンドルできる
- **API は完全に同期。** データはメモリ上にあるので、Promise を返すものは何もない。終端メソッドはプレーンな配列を返すため、ネイティブの配列メソッドがいつでも逃げ道として使える
- **Node 用のヘルパーは専用のエントリポイント** （`steledb/node`）に分けてあり、ファイルシステムからのロードと CI 向けの検証ランナーを提供する
- **GUI コンソールが付属する。** [`steledb studio`](#studio) はブラウザでデータを閲覧し、外部キーを双方向にたどり、ファイルを再フォーマットせずに行を編集する

## インストール

```bash
npm install steledb
```

Node.js 22.18.0 以降が必要で、ESM のみ（CommonJS ビルドは同梱していない）。

CLI もパッケージに含まれるので、依存しているプロジェクトから `npx steledb check` がそのまま使える。[CLI](#cli) と [studio](#studio) を参照。

Vite や Astro から使っていて事前バンドルが邪魔になる場合は、`optimizeDeps.exclude: ["steledb"]` を設定する。

## クイックスタート

完全な例は [`example/`](example/) にある。`file:` 参照で steledb に依存する独立したプロジェクトで、スキーマは [`src/db/schema.ts`](example/src/db/schema.ts)、テーブルごとの JSON は [`src/data/`](example/src/data/)、クエリ層は [`src/index.ts`](example/src/index.ts) にあり、[`src/index.test.ts`](example/src/index.test.ts) が以下のコードの正しさを保証している。

### 1. スキーマを定義する

```ts
import { defineSchema, desc, t, table, type InferRow } from "steledb";

const authors = table("authors", {
  id: t.string().primaryKey(),
  name: t.string(), // ユニークにしない: 同姓同名の著者はいてよい
});

const awards = table("awards", {
  id: t.string().primaryKey(),
  name: t.string().unique(), // 賞の名前は人名と違って一意
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
    // 同じ賞を同じ年に二度受賞することはない。ただし 1 年に複数の賞を
    // 受賞することはあるので、キーの片方だけでは足りない
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

export const schema = defineSchema({ authors, awards, books });

type Book = InferRow<typeof books>; // 行の型は推論される。手で書くことはない
```

`defineSchema()` はスキーマを凍結し、**その場でランタイム検証を行う**。参照先が存在すること、FK の参照先がユニークであること、`via` で指した兄弟フィールドが存在すること、PK が多くとも 1 つであること、などだ。壊れたスキーマは import された瞬間に失敗する。

### 2. 検証する

```ts
import { formatErrors, validate } from "steledb";

const result = validate(schema, { authors, awards, books }); // data は Record<スキーマのキー, unknown[]>
if (!result.ok) {
  console.error(formatErrors(result.errors)); // 全エラーを人間が読める形で
  // result.errors は構造化データ (code / table / rowLabel / path / pathString ...)
}
```

### 3. クエリを書く

```ts
import { createDb, eq, some, unnest } from "steledb";

const db = createDb(schema, data); // 検証しない (CI 側で済んでいる前提)

db.get(schema.books, "b1");                  // PK による O(1) -> Book | undefined
db.getBy(schema.books.slug, "second-book");  // ユニークカラムによる O(1)
db.all(schema.books);                        // 全件、defaultOrder 適用済み

// select ビルダー: 戻り値の型は射影から推論される
db.select({ id: schema.books.id, title: schema.books.title })
  .from(schema.books)
  .where(some(schema.books.credits, (credit) => eq(credit.authorId, "a2")))
  .all(); // { id: string; title: string }[]

// unnest はネストした配列を行に展開する。$parent で元の行に届く
const win = unnest(schema.books.awards);
db.select({ year: win.year, title: win.$parent.title })
  .from(win)
  .where(eq(win.awardId, "hugo"))
  .all(); // { year: number; title: string }[]
```

## スキーマ DSL リファレンス

### カラム型と修飾子

| ビルダー | 行の型 |
|---|---|
| `t.string()` / `t.number()` / `t.boolean()` | `string` / `number` / `boolean` |
| `t.enum("a", "b")` | `"a" \| "b"`（リテラルユニオン） |
| `t.array(inner)` | `Inner[]` |
| `t.object({ ... })` | ネストしたオブジェクト |
| `.nullable()` | `T \| null` |
| `.optional()` | `key?: T`（JSON からキー自体が欠けていてよい） |
| `.primaryKey()` | 主キー。ユニークを含意する。1 テーブルに 1 カラム |
| `.unique()` | テーブル全体で重複を禁止（null が複数あるのは許容） |

JSON に undefined はないので、`optional` が意味するのは常に「キーが存在しない」ことだけ。本当の主キーを持たないテーブルでは、主キーの役割を果たしているカラムに `.primaryKey()` を付ける（たとえば `setlists.liveEventId`）。複数カラムからなるキーは代わりに[テーブルオプション](#テーブル単位の複合キー)で宣言する。

### 参照制約

```ts
// 外部キー。thunk 形式が基本 (リファクタリングに強い)
liveId: t.string().nullable().references(() => lives.id),

// 文字列形式。循環参照など型を組み立てられないケースのための代替手段
liveId: t.string().references("lives", "id"),

// スカラー配列の FK、ネストした配列の中の FK、二重にネストした FK も同じ書き方
coveredLiveIds: t.array(t.string().references(() => lives.id)),
```

FK の参照先は `primaryKey` または `unique` なカラムでなければならない。値が null の場合とキーが欠けている場合はチェックされない（nullable な FK、optional な FK）。

### 非正規化フィールドの照合 (mustMatch)

参照先の名前などを冗長に保持しているフィールドのための機能。同じオブジェクトスコープにある FK フィールドを `via` で指定すると、値がマスター行と比較される。

```ts
// 厳密: artists[].name はマスターの name と完全に一致しなければならない
name: t.string().mustMatch(() => artists.name, { via: "id" }),

// 別名を許容: venue は venues.name と一致するか venues.alias[] に含まれていればよい
venue: t.string().nullable().mustMatch(() => venues.name, {
  via: "venueId",
  orIn: () => venues.alias,
}),

// チェックしない = 宣言しない (表記の揺れを許容したいフィールド向け)
```

### スコープ付き複合ユニーク (uniqueBy)

親レコード内の配列の中での重複を禁止する。キー関数を取る形なので、既定値の扱いも自然に書ける。

```ts
tracks: t.array(trackShape).uniqueBy((track) => [track.disc ?? 1, track.no]),
```

### テーブル単位の複合キー

`.primaryKey()` と `.unique()` が扱うのは 1 カラムだけ。レコードを識別するのに複数カラムの組み合わせが必要なとき（中間テーブルによくある形）は、テーブルオプションで宣言する。そこでは `self` 経由でカラムに到達できる。

```ts
table("songRankings", {
  songId: t.string().references(() => songs.id),
  year: t.number(),
  rank: t.number(),
}, (self) => ({
  primaryKey: [self.songId, self.year],  // 1 曲は 1 年に多くとも 1 回登場する
  unique: [[self.year, self.rank]],      // 同じ年に同じ順位の曲は 2 つない
}));
```

各エントリには、そのテーブル自身のスカラーカラムを 2 つ以上並べる（1 カラムならカラム側の `.primaryKey()` / `.unique()` を使う。外部キーが参照できるのもこちら）。ユニークな組み合わせは一度に複数宣言できる: `unique: [[a, b], [c, d]]`。

複合主キーは、`.primaryKey()` が `.unique()` を含意するのと同じように、それ自身で重複を禁止する。また、そのメンバーを `.nullable()` や `.optional()` にはできない。カラム側の `.primaryKey()` と設定側の `primaryKey` の両方で宣言するのはエラーになる。テーブルの主キーは多くとも 1 つだからだ。

このとき `db.get()` はキーを宣言順のタプルで受け取り、その順序はコンパイル時にチェックされる。

```ts
db.get(songRankings, ["s1", 2013]);
db.get(songRankings, [2013, "s1"]); // 型エラー: メンバーは (songId, year)
```

SQL で NULL 同士が区別されるのと同様に、null や欠けたメンバーを含むユニークタプルは比較不能として扱われ、衝突することはない。

外部キーが指せるのは依然として単一カラムなので、複合キーを参照先にはできない。`primaryKey` / `unique` なカラムを指すか、組み合わせを `checks` で検査する。

### テーブルオプション

```ts
table("events", { ... }, (self) => ({
  defaultOrder: [desc(self.eventDate)],            // db.all() と select の既定の並び順
  displayAs: (row) => `"${row.name}" (${row.id})`, // 検証エラーで行をどう表示するか
  checks: [(row) => (row.endDate >= row.startDate ? null : "endDate is earlier than startDate")],
  primaryKey: [self.songId, self.year],            // 複合主キー
  unique: [[self.year, self.rank]],                // 複合ユニーク制約
}));
```

## 検証 (validation)

```ts
const result = validate(schema, data, { unknownKeys: "error" }); // "error" が既定値
```

検証の順序は **形状**（型、enum、nullable / optional 違反、未知のキー）→ **PK / ユニークの重複**（単一カラムと複合）→ **FK の存在**→ **mustMatch** → **uniqueBy** → **checks**。fail fast はせず全件を収集するが、形状が壊れている行はノイズを抑えるためリレーショナルチェックをスキップする。

エラーは判別可能なユニオンによる構造化データとして返る。

```ts
type ValidationError = {
  table: string;            // スキーマのキー
  rowIndex: number;
  rowKey: string | number | null;   // PK の値
  rowLabel: string;         // displayAs の結果
  path: (string | number)[];        // ["coveredEvents", 0, "tracks", 3, "songId"]
  pathString: string;       // "coveredEvents[0].tracks[3].songId"
  message: string;
} & (
  | { code: "SHAPE_MISMATCH"; expected: string; actual: unknown }
  | { code: "UNKNOWN_KEY"; key: string }
  | { code: "DUPLICATE_KEY"; column: string; value: unknown; otherRowIndex: number }
  | { code: "DUPLICATE_COMPOSITE_KEY"; columns: string[]; values: unknown[];
      otherRowIndex: number }
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
const db = createDb(schema, data);          // データを信頼してそのまま保持する (コストゼロ)
const db = createValidatedDb(schema, data); // 検証してから構築する (開発時とテスト)

db.get(table, pk);            // PK の Map インデックスによる O(1)。PK がなければ型レベルで使えない
db.get(table, [a, b]);        // 複合 PK は宣言順のタプルで渡す
db.getOrThrow(table, pk);
db.getBy(table.col, value);   // ユニークカラムのみ。コンパイル時とランタイムの両方で強制される
db.all(table);                // defaultOrder 適用済み (キャッシュされる)
db.rowsOf(table);             // 生の行を挿入順で
db.count(table);
```

### select ビルダー

```ts
db.select(projection?)        // 射影: カラム参照や式 -> 値 / テーブル -> 行全体
  .from(source)               // テーブルまたは unnest()
  .innerJoin(table, on) / .leftJoin(table, on)
  .where(condition)           // 複数回呼ぶと AND される
  .orderBy(desc(col, { nulls: "last" }), col2)  // 式をそのまま渡すと暗黙の asc
  .limit(n)
  .distinctBy((row) => key)   // 射影後の行に対して効く
  .all() / .first() / .firstOrThrow() / .count() / .countBy((row) => key)
```

演算子: `eq ne gt gte lt lte inArray notInArray isNull isNotNull and or not`。配列向けには `some`（要素の述語）と `arrayContains`（スカラー配列への包含）がある。

```ts
// ネストした配列を通した逆引き
db.select().from(songs).where(some(songs.artists, (a) => eq(a.id, artistId))).all();

// 二重ネストには some を入れ子にする
db.select().from(videos).where(
  some(videos.coveredEvents, (ce) => some(ce.tracks, (tr) => eq(tr.songId, songId))),
).all();
```

### unnest と join

`unnest()` はトップレベルの配列カラムを、要素 1 つを 1 行とする仮想テーブルに展開する（SQL の unnest に相当）。

```ts
const item = unnest(schema.setlists.items);
// item.songId ... 要素のフィールドを表す式
// item.$parent.liveEventId ... 親の行のカラム参照 (親テーブル自体も射影できる)
// item.$index / item.$ ... 配列内の位置 / 要素そのもの

// 多段 join: 曲 -> セットリスト -> イベント -> ツアー
db.select({ live: schema.lives, event: schema.events })
  .from(item)
  .where(eq(item.songId, songId))
  .innerJoin(schema.events, eq(item.$parent.liveEventId, schema.events.id))
  .innerJoin(schema.lives, eq(schema.events.liveId, schema.lives.id))
  .distinctBy((r) => r.live.id)
  .all();

// 集計: 各曲が何件のイベントで演奏されたか (1 イベント内の繰り返しは 1 回と数える)
db.select({ songId: item.songId, eventId: item.$parent.liveEventId })
  .from(item)
  .distinctBy((r) => `${r.songId}:${r.eventId}`)
  .countBy((r) => r.songId);   // Map<string, number>
```

- join の `on` が「join 対象テーブルのカラム = 外側の式」という形の eq のときはハッシュ結合になる。それ以外はネストループ
- 射影なしで join すると `{ [テーブル名]: 行 }` というキー付きの結果になる。`leftJoin` でマッチしなかった場合は `null` が入る
- **v1 で意図的に妥協している型の話**（Drizzle と同じトレードオフ）:
  - where 句や射影に出てくるカラムが join 済みのソースに属しているかどうかは型チェックされない（ランタイムで専用のメッセージとともに即座に失敗する）
  - `leftJoin` が `| null` を足すのはテーブル全体を射影したエントリのみで、個別カラムの射影は nullable にならない
  - ソースが `unnest` の join には射影が必須

## Node ヘルパー (steledb/node)

```ts
import { loadTablesFromDir, runIntegrityCheck } from "steledb/node";

// スキーマの全テーブルを JSON ディレクトリからロードする
const data = await loadTablesFromDir(new URL("../src/data/", import.meta.url), schema, {
  fileFor: (key) => `${key === "digitalSingles" ? "digital-singles" : key}.json`,
});
```

CI 向けのチェックスクリプトは 4 行で済む。Node 22.18 以降は TS を直接実行できるので tsx は不要（ただしスキーマ側は erasable syntax に限られ、パスエイリアスは使えない点に注意）。

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

`runIntegrityCheck` は全エラーを列挙して `process.exitCode = 1` を設定する。成功時はテーブルごとの行数サマリを出力する。

## CLI

同じチェックは、自前のスクリプトなしでも実行できる。スキーマファイルは動的 import されるので `.ts` のまま動く。

```bash
steledb check --schema src/db/schema.ts --data src/data/
steledb check --schema src/db/schema.ts --data src/data/ --json   # 機械可読、CI 向け
```

```jsonc
// package.json
{ "scripts": { "check:data": "steledb check --schema src/db/schema.ts --data src/data/" } }
```

`--export <name>` でスキーマを保持している export を選ぶ（既定は `schema`）。終了コードは成功が 0、整合性エラーが 1、使い方の誤りが 2。

## studio

`steledb studio` は同じスキーマの上にローカルの GUI コンソールを開く。スキーマが宣言したすべての関係をたどれる、ブラウザ上のデータビューだ。

```bash
steledb studio --schema src/db/schema.ts --data src/data/
# steledb studio is running
#   http://127.0.0.1:4321/#t=1f0c…
#   9 tables · data integrity OK
```

表示された URL を開く。フラグメントにセッショントークンが載っている。`--open` はブラウザを自動で起動し、`--port <n>` はポートを指定し（既定は 4321。使用中なら空いているポートにフォールバックする）、`--read-only` は編集を許さずデータを配信する。

JSON ファイルを手で開くのに比べて得られるもの:

- **外部キーをたどれる。** FK のセルはすべてリンクになっている。クリックすると値を解決して参照先の行に飛ぶ。ネストの深さは問わず、`tracks[].songId` もトップレベルのカラムと同じようにリンクする
- **逆参照が見える。** 各行には、その行を参照している行がカラムごとにまとめて並び、どのパスから来たかがラベルとして付く（`coveredEvents[2].tracks[0].songId`）。参照が 1 件もない行はそう表示される。何かを削除する前に本当に知りたいのはこれだ
- **整合性エラーがその場に出る。** `steledb check` を支えているのと同じ `validate()` がロード時と保存後に毎回走り、問題のあるセルがハイライトされ、行パネルにメッセージが並ぶ
- **行を編集できる。** スカラーカラムにはスキーマから導かれたウィジェットが付く（enum はセレクト、nullable カラムには null トグル）。配列とオブジェクトは JSON として編集する。行の追加、複製、削除もできる
- **ライブリロード。** データディレクトリを監視しているので、エディタでの編集がリロードなしに反映される

保存されたファイルはレビュー可能なまま保たれる。元のインデント、末尾の改行、キーの順序は保持され、触っていない行は元のテキストそのままで書き戻される。だから 1 セルの編集は 1 行の差分になる。レコードが手で 1 行に整形されているファイルでも同じだ。

これが成り立つのは他の何もファイルを再フォーマットしない場合だけなので、データディレクトリはフォーマッタ（Prettier、Biome、`editor.formatOnSave`）の対象から除外しておくこと。そうしないとフォーマッタの実行と studio の保存がレイアウトを取り合い、コミットごとにノイズが乗る。

書き込みアクセスは 2 つの仕組みで守られている。サーバーは `127.0.0.1` にのみバインドされ、すべての API 呼び出しは起動時に生成されたトークンを提示しなければならない（加えて Host ヘッダのチェックが DNS リバインディングを防ぐ）。見るだけなら `--read-only` を使う。

コードから起動することもできる。kebab-case のファイル名に対して `fileFor` を渡したいときはこちらを使う。

```ts
import { startStudio } from "steledb/studio";
import { schema } from "./src/db/schema.ts";

const studio = await startStudio({
  schema,
  dataDir: new URL("./src/data/", import.meta.url),
  fileFor: (key) => `${key === "digitalSingles" ? "digital-singles" : key}.json`,
});
console.log(studio.url);
// await studio.close();
```

## 検証スクリプトからの移行

データ構造に対してハードコードされた検証スクリプト（たとえば「songs の artists[].id がすべて artists.json に存在するか」を手で歩いて確かめているもの）は、次のようにスキーマ宣言へ対応づけられる。

| ハードコードされたチェック | steledb での宣言 |
|---|---|
| id の重複チェック | `.primaryKey()` / `.unique()` |
| 複数カラムの組み合わせの重複 | テーブルオプションの `unique: [[self.a, self.b]]`（または `primaryKey: [self.a, self.b]`） |
| 参照先の id が存在するか | `.references(() => master.id)` |
| 冗長に持った名前が一致するか | `.mustMatch(() => master.name, { via: "id" })` |
| 別名を許容した一致 | `mustMatch` に `orIn: () => master.alias` を添える |
| ディスク内でのトラック番号の重複 | `.uniqueBy((tr) => [tr.disc ?? 1, tr.no])` |
| その他の任意のルール | テーブルオプションの `checks` |

スキーマで宣言した参照はすべて自動的に検証されるので、「検証スクリプトに追加するのを忘れた参照」というカテゴリの問題ごと消える。

## v1 のスコープ外

書き込み API / トランザクション / マイグレーション、SQL 文字列のパーサ、リレーション定義（`with` 風の API）、count を超える集計（`Map.groupBy` や `reduce` を使う）、値のフォーマット検証（正規表現 / min / max — `checks` を使う）、CJS ビルド、i18n。

（studio は JSON ファイルに書き込むが、あれはソースデータを編集する開発ツールであって、クエリ API 自体は読み取り専用のままだ。）

## 開発

```bash
npm run check   # lint + typecheck + build + test + コアの node: import チェック + example プロジェクト
npm run test    # vitest (.test.ts と .test-d.ts)
npm run dev     # tsc --watch
```

- ランタイムのテストは `src/*.test.ts`、型のテストは `src/*.test-d.ts`（`expectTypeOf` を使う）
- `scripts/check-core-imports.mjs` は、コア（`src/node`、`src/cli`、`src/studio` 以外すべて）に `node:` の import が紛れ込んでいないことを検証する
- [`example/`](example/) は `file:..` 経由で `steledb` に依存する独立した npm プロジェクトで、相対 import ではなく公開されたエントリポイントを実際に通す。`npm run check:example` はそれをインストールし、typecheck、テスト、`steledb check` を走らせる。`file:` 依存では `prepare` が走らないため、先に `npm run build` が必要
- studio のフロントエンドは `src/studio/assets/` にあるプレーンな HTML / CSS / ES モジュールで、それ自体のビルドステップは持たない。tsc は TypeScript しか出力しないので `scripts/copy-assets.mjs` が `dist` へコピーしている

## ライセンス

MIT
