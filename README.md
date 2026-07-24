# jsonrdb

JSON ファイル群を静的 RDB として扱う TypeScript ライブラリ。

Git 管理された静的データ（1 JSON ファイル = 1 テーブル）に対して、Drizzle 風のスキーマ定義から

1. リレーショナル整合性検証（PK / unique / FK / 非正規化フィールドの一致検証）
2. 型付きクエリ API（O(1) lookup / select ビルダー / ネスト配列の join）

を提供します。コアはランタイム依存ゼロ・fs 非依存で、Cloudflare Workers 等にそのままバンドルできます。

ドキュメントは実装完了後に整備予定。
