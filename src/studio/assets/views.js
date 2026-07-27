/**
 * Rendering. Every function here takes plain data plus a handlers object and
 * returns (or fills) DOM — no state of its own, so app.js stays the single
 * owner of "what is on screen right now".
 */
import { clear, compareValues, el, rowMatches, summarize, valueClass } from "./dom.js";

export const PAGE_SIZE = 100;

/** Route helpers, kept next to the views that build the links. */
export const routes = {
  table: (key) => `#/${encodeURIComponent(key)}`,
  row: (key, rowIndex) => `#/${encodeURIComponent(key)}/${rowIndex}`,
  lookup: (key, column, value) =>
    `#/${encodeURIComponent(key)}/@${encodeURIComponent(column)}/${encodeURIComponent(String(value))}`,
};

// --- sidebar ---------------------------------------------------------------

export function renderSidebar(container, { meta, counts, errorCounts, activeTable }) {
  clear(container);
  for (const table of meta.tables) {
    const errors = errorCounts.get(table.key) ?? 0;
    container.append(
      el(
        "li",
        {},
        el(
          "button",
          {
            class: table.key === activeTable ? "active" : "",
            onclick: () => {
              location.hash = routes.table(table.key);
            },
            title: table.name === table.key ? table.file : `${table.name} — ${table.file}`,
          },
          el("span", { class: "name", text: table.key }),
          errors > 0 ? el("span", { class: "err", text: `${errors}⚠` }) : null,
          el("span", { class: "count", text: String(counts.get(table.key) ?? 0) }),
        ),
      ),
    );
  }
}

// --- grid ------------------------------------------------------------------

/**
 * Applies the filter and sort to the raw rows. Rows keep their original index
 * because every route, error and save path addresses rows by position in the
 * file, not by their position on screen.
 */
export function visibleRows(rows, { filter, sort }) {
  const needle = filter.trim().toLowerCase();
  const entries = [];
  rows.forEach((row, rowIndex) => {
    if (rowMatches(row, needle)) entries.push({ row, rowIndex });
  });
  if (sort !== null) {
    const direction = sort.dir === "desc" ? -1 : 1;
    entries.sort((a, b) => direction * compareValues(a.row?.[sort.column], b.row?.[sort.column]));
  }
  return entries;
}

/** The "9 rows · songs.json · pk: id · unique: (liveId, no)" line under the table title. */
function tableSummaryOf(table, rowCount) {
  const parts = [`${rowCount} rows`, table.file, table.pk === null ? "no pk" : `pk: ${table.pk}`];
  for (const columns of table.compositeUniques) {
    parts.push(`unique: (${columns.join(", ")})`);
  }
  return parts.join(" · ");
}

export function renderTableView(main, ctx) {
  const { table, rows, filter, sort, page, errorsByRow, selectedRow, readOnly, handlers } = ctx;
  clear(main);

  const entries = visibleRows(rows, { filter, sort });
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageEntries = entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const search = el("input", {
    type: "search",
    placeholder: `Filter ${table.key}…`,
    value: filter,
    oninput: (event) => handlers.onFilter(event.target.value),
  });

  main.append(
    el(
      "div",
      { class: "table-head" },
      el(
        "div",
        { class: "table-title" },
        el("h1", { text: table.key }),
        el("span", {
          class: "meta",
          text: tableSummaryOf(table, rows.length),
        }),
      ),
      el(
        "div",
        { class: "table-tools" },
        search,
        el("span", {
          class: "meta",
          text: entries.length === rows.length ? "" : `${entries.length} matched`,
        }),
        el("div", { class: "topbar-spacer" }),
        el("button", {
          class: "btn primary",
          text: "+ New row",
          disabled: readOnly,
          title: readOnly ? "the studio is running in read-only mode" : "append a row",
          onclick: () => handlers.onNewRow(),
        }),
      ),
    ),
  );

  const head = el(
    "tr",
    {},
    el("th", { class: "rownum", text: "#" }),
    ...table.columns.map((column) => renderColumnHeader(column, sort, handlers)),
  );

  const body = el("tbody");
  for (const { row, rowIndex } of pageEntries) {
    body.append(
      renderRow({
        table,
        row,
        rowIndex,
        errorsByRow,
        selected: rowIndex === selectedRow,
        handlers,
      }),
    );
  }

  main.append(
    el(
      "div",
      { class: "grid-wrap" },
      el("table", { class: "grid" }, el("thead", {}, head), body),
      entries.length === 0
        ? el("div", { class: "empty", text: rows.length === 0 ? "No rows yet." : "No matches." })
        : null,
    ),
  );

  if (pageCount > 1) {
    main.append(
      el(
        "div",
        { class: "pager" },
        el("button", {
          class: "btn",
          text: "← Prev",
          disabled: currentPage === 0,
          onclick: () => handlers.onPage(currentPage - 1),
        }),
        el("span", {
          text: `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, entries.length)} of ${entries.length}`,
        }),
        el("button", {
          class: "btn",
          text: "Next →",
          disabled: currentPage >= pageCount - 1,
          onclick: () => handlers.onPage(currentPage + 1),
        }),
      ),
    );
  }
}

function renderColumnHeader(column, sort, handlers) {
  const badges = [];
  if (column.primaryKey) badges.push(el("span", { class: "badge badge-pk", text: "PK" }));
  else if (column.unique) badges.push(el("span", { class: "badge badge-uq", text: "UQ" }));
  if (column.reference !== undefined) {
    badges.push(
      el("span", {
        class: "badge badge-fk",
        text: "FK",
        title: `→ ${column.reference.table}.${column.reference.column}`,
      }),
    );
  }
  const arrow = sort !== null && sort.column === column.key ? (sort.dir === "asc" ? "▲" : "▼") : "";
  return el(
    "th",
    {
      onclick: () => handlers.onSort(column.key),
      title: `${column.key}: ${column.typeLabel}${column.optional ? " (optional)" : ""}`,
    },
    el(
      "div",
      { class: "col-name" },
      column.key,
      ...badges,
      arrow === "" ? null : el("span", { class: "sort-arrow", text: arrow }),
    ),
    el("div", {
      class: "col-type",
      text: `${column.typeLabel}${column.optional ? "?" : ""}`,
    }),
  );
}

function renderRow({ table, row, rowIndex, errorsByRow, selected, handlers }) {
  const errors = errorsByRow.get(rowIndex) ?? [];
  const errorColumns = new Set();
  let rowLevelError = false;
  for (const error of errors) {
    if (error.path.length === 0) rowLevelError = true;
    else errorColumns.add(error.path[0]);
  }

  const cells = table.columns.map((column) => {
    const value = row === null || typeof row !== "object" ? undefined : row[column.key];
    const classes = [valueClass(value), errorColumns.has(column.key) ? "has-error" : ""]
      .filter(Boolean)
      .join(" ");
    const title = errors
      .filter((error) => error.path[0] === column.key)
      .map((error) => error.message)
      .join("\n");

    if (column.reference !== undefined && value !== null && value !== undefined) {
      return el(
        "td",
        { class: classes, title },
        el("a", {
          class: "fk",
          href: routes.lookup(column.reference.table, column.reference.column, value),
          text: String(value),
          title: `→ ${column.reference.table}.${column.reference.column}`,
          onclick: (event) => event.stopPropagation(),
        }),
      );
    }
    return el("td", { class: classes, title, text: summarize(value) });
  });

  return el(
    "tr",
    {
      class: selected ? "selected" : "",
      onclick: () => handlers.onOpenRow(rowIndex),
    },
    el("td", {
      class: `rownum${rowLevelError ? " has-error" : ""}`,
      text: String(rowIndex),
      title: rowLevelError ? errors.map((error) => error.message).join("\n") : "",
    }),
    ...cells,
  );
}

// --- row drawer ------------------------------------------------------------

/**
 * Builds the row editor. Returns { node, collect } where collect() rebuilds the
 * row from the inputs — starting from a copy of the original row so untouched
 * keys keep their position, which is what keeps saved diffs small.
 */
export function renderDrawer(drawer, ctx) {
  const { table, row, rowIndex, detail, errors, readOnly, handlers } = ctx;
  clear(drawer);
  drawer.hidden = false;

  const fields = [];

  const outgoingByPath = new Map();
  for (const link of detail.outgoing ?? []) {
    const list = outgoingByPath.get(link.pathString);
    if (list === undefined) outgoingByPath.set(link.pathString, [link]);
    else list.push(link);
  }

  const body = el("div", { class: "drawer-body" });

  for (const column of table.columns) {
    const field = buildField({ column, row, outgoingByPath, readOnly });
    fields.push(field);
    body.append(field.node);
  }

  if (errors.length > 0) {
    body.append(
      el(
        "div",
        { class: "section" },
        el("h3", { text: `Integrity errors (${errors.length})` }),
        el(
          "ul",
          { class: "error-list" },
          ...errors.map((error) =>
            el(
              "li",
              { class: "error-item" },
              el("div", { text: error.message }),
              el(
                "div",
                { class: "where" },
                el("span", { class: "code", text: error.code }),
                ` ${error.pathString === "" ? "(row)" : error.pathString}`,
              ),
            ),
          ),
        ),
      ),
    );
  }

  body.append(renderBacklinks(detail.backlinks ?? []));

  const label = detail.label ?? `row ${rowIndex}`;
  drawer.append(
    el(
      "div",
      { class: "drawer-head" },
      el("h2", { text: `${table.key} · ${label}` }),
      el("button", { class: "btn", text: "✕", title: "close", onclick: () => handlers.onClose() }),
    ),
    body,
    el(
      "div",
      { class: "drawer-foot" },
      el("button", {
        class: "btn primary",
        text: "Save",
        disabled: readOnly,
        onclick: () => handlers.onSave(collect()),
      }),
      el("button", {
        class: "btn",
        text: "Duplicate",
        disabled: readOnly,
        onclick: () => handlers.onDuplicate(),
      }),
      el("div", { class: "spacer" }),
      el("button", {
        class: "btn danger",
        text: "Delete",
        disabled: readOnly,
        onclick: () => handlers.onDelete(),
      }),
    ),
  );

  /** Rebuilds the row from the widgets, or throws with the first invalid field. */
  function collect() {
    const next = { ...(row ?? {}) };
    for (const field of fields) {
      const result = field.read();
      if (result.error !== undefined) {
        throw new Error(`${field.key}: ${result.error}`);
      }
      if (result.absent) delete next[field.key];
      else next[field.key] = result.value;
    }
    return next;
  }

  return { collect };
}

function renderBacklinks(groups) {
  const section = el("div", { class: "section" }, el("h3", { text: "Referenced by" }));
  if (groups.length === 0) {
    section.append(
      el("div", {
        class: "field-note",
        text: "Nothing points at this row — it can be deleted safely.",
      }),
    );
    return section;
  }
  for (const group of groups) {
    section.append(
      el(
        "div",
        { class: "ref-group" },
        el("div", {
          class: "ref-group-title",
          text: `${group.column} = ${JSON.stringify(group.value)} · ${group.refs.length}`,
        }),
        el(
          "ul",
          { class: "ref-list" },
          ...group.refs.map((ref) =>
            el(
              "li",
              {},
              el(
                "a",
                { href: routes.row(ref.table, ref.rowIndex) },
                el("span", { class: "ref-table", text: ref.table }),
                el("span", { class: "ref-label", text: ref.rowLabel }),
                el("span", { class: "ref-path", text: ref.pathString }),
              ),
            ),
          ),
        ),
      ),
    );
  }
  return section;
}

/**
 * One editor row. Scalars get a typed widget; arrays and objects get a JSON
 * textarea, which covers nested structures without a bespoke tree editor.
 */
function buildField({ column, row, outgoingByPath, readOnly }) {
  const present = row !== null && typeof row === "object" && column.key in row;
  const value = present ? row[column.key] : undefined;

  const labelBits = [
    el("span", { class: "key", text: column.key }),
    el("span", { class: "type", text: `${column.typeLabel}${column.optional ? "?" : ""}` }),
  ];
  if (column.primaryKey) labelBits.push(el("span", { class: "badge badge-pk", text: "PK" }));
  else if (column.unique) labelBits.push(el("span", { class: "badge badge-uq", text: "UQ" }));

  const controls = el(
    "div",
    { class: "field-label" },
    ...labelBits,
    el("div", { class: "spacer" }),
  );

  let nullToggle = null;
  if (column.nullable) {
    nullToggle = el("input", { type: "checkbox", ...(value === null ? { checked: true } : {}) });
    if (readOnly) nullToggle.disabled = true;
    controls.append(el("label", { class: "null-toggle" }, nullToggle, "null"));
  }

  let absentToggle = null;
  if (column.optional) {
    absentToggle = el("input", { type: "checkbox", ...(present ? {} : { checked: true }) });
    if (readOnly) absentToggle.disabled = true;
    controls.append(el("label", { class: "null-toggle" }, absentToggle, "unset"));
  }

  const widget = buildWidget(column, value, readOnly);
  const note = el("div", { class: "field-note" });

  const syncDisabled = () => {
    const disabled = readOnly || (nullToggle?.checked ?? false) || (absentToggle?.checked ?? false);
    widget.input.disabled = disabled;
  };
  nullToggle?.addEventListener("change", syncDisabled);
  absentToggle?.addEventListener("change", syncDisabled);
  syncDisabled();

  const node = el("div", { class: "field" }, controls, widget.input, note);

  const links = collectLinksFor(column, outgoingByPath);
  if (links.length > 0) {
    node.append(
      el(
        "div",
        { class: "ref-list" },
        ...links.map((link) =>
          el(
            "a",
            {
              class: "fk",
              href:
                link.resolved === null
                  ? routes.table(link.targetTable)
                  : routes.row(link.targetTable, link.resolved.rowIndex),
              text:
                link.resolved === null
                  ? `⚠ ${link.pathString} → ${link.targetTable}.${link.targetColumn} not found`
                  : `→ ${link.targetTable}: ${link.resolved.rowLabel}${
                      link.pathString === column.key ? "" : ` (${link.pathString})`
                    }`,
            },
            null,
          ),
        ),
      ),
    );
  }

  return {
    key: column.key,
    node,
    read() {
      if (absentToggle?.checked) return { absent: true };
      if (nullToggle?.checked) return { value: null };
      return widget.read(note);
    },
  };
}

function collectLinksFor(column, outgoingByPath) {
  const links = [];
  for (const [pathString, group] of outgoingByPath) {
    const head = pathString.replace(/[.[].*$/, "");
    if (head === column.key) links.push(...group);
  }
  return links.slice(0, 12);
}

function buildWidget(column, value, readOnly) {
  if (column.composite) {
    const input = el("textarea", {
      spellcheck: "false",
      ...(readOnly ? { disabled: true } : {}),
    });
    input.value = value === undefined ? "" : JSON.stringify(value, null, 2);
    return {
      input,
      read(note) {
        const text = input.value.trim();
        if (text === "") {
          input.classList.remove("invalid");
          note.textContent = "";
          return { value: column.kind === "array" ? [] : {} };
        }
        try {
          const parsed = JSON.parse(text);
          input.classList.remove("invalid");
          note.textContent = "";
          return { value: parsed };
        } catch (error) {
          input.classList.add("invalid");
          note.textContent = String(error.message);
          note.className = "field-note bad";
          return { error: `invalid JSON — ${error.message}` };
        }
      },
    };
  }

  if (column.kind === "enum") {
    const input = el(
      "select",
      { ...(readOnly ? { disabled: true } : {}) },
      ...(column.enumValues ?? []).map((option) =>
        el("option", { value: option, ...(option === value ? { selected: true } : {}) }, option),
      ),
    );
    return { input, read: () => ({ value: input.value }) };
  }

  if (column.kind === "boolean") {
    const input = el(
      "select",
      { ...(readOnly ? { disabled: true } : {}) },
      el("option", { value: "true", ...(value === true ? { selected: true } : {}) }, "true"),
      el("option", { value: "false", ...(value === false ? { selected: true } : {}) }, "false"),
    );
    return { input, read: () => ({ value: input.value === "true" }) };
  }

  if (column.kind === "number") {
    const input = el("input", {
      type: "number",
      step: "any",
      ...(readOnly ? { disabled: true } : {}),
    });
    input.value = typeof value === "number" ? String(value) : "";
    return {
      input,
      read(note) {
        if (input.value.trim() === "") {
          note.textContent = "";
          return { error: "a number is required" };
        }
        const parsed = Number(input.value);
        if (Number.isNaN(parsed)) return { error: `"${input.value}" is not a number` };
        note.textContent = "";
        return { value: parsed };
      },
    };
  }

  // strings: a textarea once the text is long or contains newlines
  const multiline = typeof value === "string" && (value.length > 80 || value.includes("\n"));
  const input = multiline
    ? el("textarea", { spellcheck: "false", ...(readOnly ? { disabled: true } : {}) })
    : el("input", { type: "text", ...(readOnly ? { disabled: true } : {}) });
  input.value = typeof value === "string" ? value : "";
  return { input, read: () => ({ value: input.value }) };
}
