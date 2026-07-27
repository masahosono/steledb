/**
 * steledb studio — a local GUI console for browsing and editing the JSON files
 * behind a schema. Node-only (it serves HTTP and touches the filesystem), so it
 * lives behind its own entry point: import it from `steledb/studio`.
 *
 * ```ts
 * import { startStudio } from "steledb/studio";
 * import { schema } from "./src/db/schema.ts";
 *
 * const studio = await startStudio({ schema, dataDir: new URL("./src/data/", import.meta.url) });
 * console.log(`studio is running at ${studio.url}`);
 * ```
 */
export {
  DEFAULT_FORMAT,
  type JsonFormat,
  type OriginalText,
  StudioConflictError,
  type TableFile,
  type WriteTableFileOptions,
  type WriteResult,
  detectFormat,
  readTableFile,
  revisionOf,
  scanArrayLayout,
  serializeRows,
  writeTableFile,
} from "./io.js";
export {
  type BuildMetaOptions,
  type StudioColumnMeta,
  type StudioIncomingReference,
  type StudioMeta,
  type StudioReference,
  type StudioTableMeta,
  blankRow,
  buildStudioMeta,
  tableKeysOf,
  typeLabelOf,
} from "./meta.js";
export {
  ReferenceIndex,
  type RowRef,
  type TableData,
  pkValueOf,
  rowLabelOf,
} from "./refs.js";
export { type StartStudioOptions, type StudioServer, startStudio } from "./server.js";
export { type SaveResult, Workspace, type WorkspaceOptions } from "./workspace.js";
