/** スキーマ定義や API の誤用など、データ以外の問題を表すエラー。 */
export class JsonRdbError extends Error {
  override name = "JsonRdbError";
}
