/**
 * The session state behind a studio server: the loaded rows, the validation
 * result, and the reference index. It owns the "when does what get rebuilt"
 * question — the reference index and the validation result are derived from the
 * data, so both are invalidated together whenever a table is reloaded or saved.
 */
import type { ValidationError } from "../errors.js";
import type { Schema, SchemaTables, TablesData } from "../schema.js";
import { type ValidateOptions, validate } from "../validate.js";
import { type TableFile, defaultFileFor, readTableFile, toDirPath, writeTableFile } from "./io.js";
import { type StudioMeta, buildStudioMeta } from "./meta.js";
import { ReferenceIndex, type TableData } from "./refs.js";

export interface WorkspaceOptions<S extends SchemaTables = SchemaTables> {
  readonly schema: Schema<S>;
  readonly dataDir: string | URL;
  readonly fileFor?: (tableKey: string) => string;
  readonly readOnly?: boolean;
  readonly validateOptions?: ValidateOptions;
}

export interface SaveResult {
  readonly revision: string;
  readonly errors: readonly ValidationError[];
}

export class Workspace<S extends SchemaTables = SchemaTables> {
  readonly schema: Schema<S>;
  readonly dirPath: string;
  readonly readOnly: boolean;
  readonly meta: StudioMeta;
  private readonly fileFor: (tableKey: string) => string;
  private readonly validateOptions: ValidateOptions;
  private readonly files = new Map<string, TableFile>();
  private cachedErrors: readonly ValidationError[] | undefined;
  private cachedRefs: ReferenceIndex | undefined;

  constructor(options: WorkspaceOptions<S>) {
    this.schema = options.schema;
    this.dirPath = toDirPath(options.dataDir);
    this.readOnly = options.readOnly ?? false;
    this.fileFor = options.fileFor ?? defaultFileFor;
    this.validateOptions = options.validateOptions ?? {};
    this.meta = buildStudioMeta(options.schema, {
      readOnly: this.readOnly,
      fileFor: this.fileFor,
    });
  }

  get tableKeys(): readonly string[] {
    return this.meta.tables.map((table) => table.key);
  }

  /** Reads every table from disk. Throws on a missing or malformed file. */
  async load(): Promise<void> {
    for (const tableKey of this.tableKeys) {
      this.files.set(tableKey, await readTableFile(this.dirPath, tableKey, this.fileFor));
    }
    this.invalidate();
  }

  /** Re-reads one table (or all of them) after an external change. */
  async reload(tableKey?: string): Promise<void> {
    const keys = tableKey === undefined ? this.tableKeys : [tableKey];
    for (const key of keys) {
      this.files.set(key, await readTableFile(this.dirPath, key, this.fileFor));
    }
    this.invalidate();
  }

  private invalidate(): void {
    this.cachedErrors = undefined;
    this.cachedRefs = undefined;
  }

  fileOf(tableKey: string): TableFile | undefined {
    return this.files.get(tableKey);
  }

  /** Maps a file name back to its table key, for translating watch events. */
  tableKeyForFile(fileName: string): string | undefined {
    for (const tableKey of this.tableKeys) {
      if (this.fileFor(tableKey) === fileName) return tableKey;
    }
    return undefined;
  }

  get data(): TableData {
    const data: Record<string, readonly unknown[]> = {};
    for (const [tableKey, file] of this.files) {
      data[tableKey] = file.rows;
    }
    return data;
  }

  get errors(): readonly ValidationError[] {
    if (this.cachedErrors === undefined) {
      const result = validate(this.schema, this.data as TablesData<S>, this.validateOptions);
      this.cachedErrors = result.errors;
    }
    return this.cachedErrors;
  }

  get refs(): ReferenceIndex {
    if (this.cachedRefs === undefined) {
      this.cachedRefs = new ReferenceIndex(this.schema, this.meta, this.data);
    }
    return this.cachedRefs;
  }

  /**
   * Replaces a table's rows and writes them back. The format captured when the
   * file was read is reused, so an unmodified save is a no-op diff.
   */
  async saveTable(
    tableKey: string,
    rows: readonly unknown[],
    expectedRevision?: string,
  ): Promise<SaveResult> {
    const file = this.files.get(tableKey);
    if (file === undefined) {
      throw new Error(`unknown table "${tableKey}"`);
    }
    const written = await writeTableFile({
      path: file.path,
      rows,
      format: file.format,
      original: { text: file.text, rows: file.rows },
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    this.files.set(tableKey, {
      ...file,
      rows,
      text: written.text,
      revision: written.revision,
    });
    this.invalidate();
    return { revision: written.revision, errors: this.errors };
  }
}
