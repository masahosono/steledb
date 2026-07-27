/**
 * The studio front end: state, routing and the glue between them.
 *
 * Rows are always addressed by their index in the file. Sorting and filtering
 * only change what is drawn, never the underlying order, so a route stays valid
 * no matter how the grid happens to be arranged.
 */
import * as api from "./api.js";
import { renderDrawer, renderSidebar, renderTableView, routes } from "./views.js";

const listNode = document.getElementById("table-list");
const mainNode = document.getElementById("main");
const drawerNode = document.getElementById("drawer");
const toastNode = document.getElementById("toast");
const errorStatusNode = document.getElementById("status-errors");
const liveStatusNode = document.getElementById("status-live");

const state = {
  meta: null,
  counts: new Map(),
  errors: [],
  activeTable: null,
  tableData: null,
  filter: "",
  sort: null,
  page: 0,
  selectedRow: null,
  detail: null,
};

let toastTimer;

function toast(message, bad = false) {
  toastNode.textContent = message;
  toastNode.className = bad ? "toast bad" : "toast";
  toastNode.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toastNode.hidden = true;
    },
    bad ? 6000 : 2200,
  );
}

function tableMeta(tableKey) {
  return state.meta?.tables.find((table) => table.key === tableKey) ?? null;
}

function errorsByRowFor(tableKey) {
  const map = new Map();
  for (const error of state.errors) {
    if (error.table !== tableKey) continue;
    const list = map.get(error.rowIndex);
    if (list === undefined) map.set(error.rowIndex, [error]);
    else list.push(error);
  }
  return map;
}

function errorCounts() {
  const counts = new Map();
  for (const error of state.errors) {
    counts.set(error.table, (counts.get(error.table) ?? 0) + 1);
  }
  return counts;
}

// --- data loading ----------------------------------------------------------

async function refreshState() {
  const payload = await api.getState();
  state.meta = payload.meta;
  state.errors = payload.errors;
  state.counts = new Map(payload.tables.map((table) => [table.key, table.rowCount]));
}

async function loadTable(tableKey) {
  const payload = await api.getTable(tableKey);
  state.tableData = { key: tableKey, rows: payload.rows, revision: payload.revision };
}

async function loadDetail(rowIndex) {
  const payload = await api.getRow(state.activeTable, rowIndex);
  state.detail = {
    ...payload,
    label: labelOf(state.activeTable, payload.row, rowIndex),
  };
}

/** Mirrors the server's row label, used for the drawer title. */
function labelOf(tableKey, row, rowIndex) {
  const table = tableMeta(tableKey);
  if (table === null || row === null || typeof row !== "object") return `row ${rowIndex}`;
  for (const key of table.labelColumns) {
    if (typeof row[key] === "string" && row[key] !== "") return row[key];
  }
  const key = table.pkColumns.map((column) => row[column]);
  if (key.length > 0 && key.every((value) => value !== undefined && value !== null)) {
    return key.join(" / ");
  }
  return `row ${rowIndex}`;
}

// --- rendering -------------------------------------------------------------

function render() {
  if (state.meta === null) return;

  renderSidebar(listNode, {
    meta: state.meta,
    counts: state.counts,
    errorCounts: errorCounts(),
    activeTable: state.activeTable,
  });

  const total = state.errors.length;
  errorStatusNode.textContent = total === 0 ? "✓ integrity OK" : `● ${total} integrity errors`;
  errorStatusNode.className = total === 0 ? "status status-errors-ok" : "status status-errors-bad";
  errorStatusNode.onclick = total === 0 ? null : jumpToFirstError;

  const table = tableMeta(state.activeTable);
  if (table === null || state.tableData === null || state.tableData.key !== state.activeTable) {
    return;
  }

  renderTableView(mainNode, {
    table,
    rows: state.tableData.rows,
    filter: state.filter,
    sort: state.sort,
    page: state.page,
    errorsByRow: errorsByRowFor(state.activeTable),
    selectedRow: state.selectedRow,
    readOnly: state.meta.readOnly,
    handlers: {
      onFilter(value) {
        state.filter = value;
        state.page = 0;
        render();
      },
      onSort(column) {
        if (state.sort !== null && state.sort.column === column) {
          state.sort = state.sort.dir === "asc" ? { column, dir: "desc" } : null;
        } else {
          state.sort = { column, dir: "asc" };
        }
        render();
      },
      onPage(page) {
        state.page = page;
        render();
      },
      onOpenRow(rowIndex) {
        location.hash = routes.row(state.activeTable, rowIndex);
      },
      onNewRow: createRow,
    },
  });

  if (state.selectedRow !== null && state.detail !== null) {
    renderDrawerView(table);
  } else {
    drawerNode.hidden = true;
  }
}

function renderDrawerView(table) {
  const errors = (errorsByRowFor(state.activeTable).get(state.selectedRow) ?? []).slice();
  renderDrawer(drawerNode, {
    table,
    row: state.detail.row,
    rowIndex: state.selectedRow,
    detail: state.detail,
    errors,
    readOnly: state.meta.readOnly,
    handlers: {
      onClose() {
        location.hash = routes.table(state.activeTable);
      },
      onSave: saveRow,
      onDuplicate: duplicateRow,
      onDelete: deleteRow,
    },
  });
}

function jumpToFirstError() {
  const first = state.errors[0];
  if (first === undefined) return;
  location.hash = routes.row(first.table, first.rowIndex);
}

// --- mutations -------------------------------------------------------------

/** Writes a new row array for the active table and folds the response back in. */
async function commit(rows, message) {
  const tableKey = state.activeTable;
  try {
    const result = await api.putTable(tableKey, rows, state.tableData.revision);
    state.tableData = { key: tableKey, rows, revision: result.revision };
    state.errors = result.errors;
    state.counts.set(tableKey, rows.length);
    toast(message);
    return true;
  } catch (error) {
    if (error.status === 409) {
      const reload = confirm(
        `${error.message}\n\nReload this table now? Unsaved changes in the panel will be lost.`,
      );
      if (reload) {
        await loadTable(tableKey);
        render();
      }
    } else {
      toast(error.message, true);
    }
    return false;
  }
}

async function saveRow(nextRow) {
  const rows = [...state.tableData.rows];
  rows[state.selectedRow] = nextRow;
  if (await commit(rows, `Saved ${state.activeTable}[${state.selectedRow}]`)) {
    await loadDetail(state.selectedRow);
    render();
  }
}

async function createRow() {
  try {
    const { row } = await api.getBlankRow(state.activeTable);
    const rows = [...state.tableData.rows, row];
    if (await commit(rows, "Row added")) {
      location.hash = routes.row(state.activeTable, rows.length - 1);
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function duplicateRow() {
  const source = state.tableData.rows[state.selectedRow];
  const copy = structuredClone(source);
  const rows = [...state.tableData.rows];
  rows.splice(state.selectedRow + 1, 0, copy);
  if (await commit(rows, "Row duplicated")) {
    location.hash = routes.row(state.activeTable, state.selectedRow + 1);
  }
}

async function deleteRow() {
  const backlinks = state.detail?.backlinks ?? [];
  const referring = backlinks.reduce((sum, group) => sum + group.refs.length, 0);
  const label = state.detail?.label ?? `row ${state.selectedRow}`;
  const warning =
    referring === 0
      ? `Delete ${state.activeTable} "${label}"?`
      : `Delete ${state.activeTable} "${label}"?\n\n${referring} row(s) still reference it — deleting will leave dangling foreign keys:\n${backlinks
          .flatMap((group) =>
            group.refs.slice(0, 5).map((ref) => `  ${ref.table}: ${ref.rowLabel}`),
          )
          .join("\n")}`;
  if (!confirm(warning)) return;

  const rows = [...state.tableData.rows];
  rows.splice(state.selectedRow, 1);
  if (await commit(rows, "Row deleted")) {
    location.hash = routes.table(state.activeTable);
  }
}

// --- routing ---------------------------------------------------------------

async function applyRoute() {
  if (state.meta === null) return;
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter((part) => part !== "");

  const tableKey =
    parts.length > 0 && tableMeta(decodeURIComponent(parts[0])) !== null
      ? decodeURIComponent(parts[0])
      : (state.meta.tables[0]?.key ?? null);
  if (tableKey === null) {
    mainNode.replaceChildren();
    return;
  }

  if (state.activeTable !== tableKey) {
    state.activeTable = tableKey;
    state.filter = "";
    state.sort = null;
    state.page = 0;
    state.selectedRow = null;
    state.detail = null;
    await loadTable(tableKey);
  } else if (state.tableData === null || state.tableData.key !== tableKey) {
    await loadTable(tableKey);
  }

  // "#/songs/@id/s1" — resolve a foreign key value to a row index, then rewrite
  // the URL so back / forward land on a stable route.
  if (parts.length >= 3 && parts[1].startsWith("@")) {
    const column = decodeURIComponent(parts[1].slice(1));
    const value = decodeURIComponent(parts.slice(2).join("/"));
    try {
      const found = await api.lookup(tableKey, column, value);
      history.replaceState(null, "", routes.row(tableKey, found.rowIndex));
      await openRow(found.rowIndex);
    } catch (error) {
      toast(error.message, true);
      state.selectedRow = null;
      state.detail = null;
      render();
    }
    return;
  }

  if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
    await openRow(Number(parts[1]));
    return;
  }

  state.selectedRow = null;
  state.detail = null;
  render();
}

async function openRow(rowIndex) {
  if (rowIndex < 0 || rowIndex >= state.tableData.rows.length) {
    toast(`${state.activeTable} has no row at index ${rowIndex}`, true);
    state.selectedRow = null;
    state.detail = null;
    render();
    return;
  }
  state.selectedRow = rowIndex;
  await loadDetail(rowIndex);
  const page = Math.floor(rowIndex / 100);
  if (state.filter === "" && state.sort === null) state.page = page;
  render();
}

// --- live updates ----------------------------------------------------------

let eventSource = null;

function connectEvents() {
  eventSource?.close();
  eventSource = api.openEvents(
    async (event) => {
      if (event.type === "load-error") {
        toast(`${event.table}: ${event.message}`, true);
        return;
      }
      if (event.type !== "table-changed") return;
      await refreshState();
      if (event.table === state.activeTable) {
        await loadTable(state.activeTable);
        if (state.selectedRow !== null) {
          if (state.selectedRow < state.tableData.rows.length) {
            await loadDetail(state.selectedRow);
          } else {
            state.selectedRow = null;
            state.detail = null;
          }
        }
        toast(`${event.table} reloaded from disk`);
      }
      render();
    },
    (online) => {
      liveStatusNode.className = online ? "status status-live" : "status status-live offline";
      liveStatusNode.textContent = online ? "live" : "offline";
    },
  );
}

// --- boot ------------------------------------------------------------------

function showTokenHelp() {
  mainNode.replaceChildren();
  const message = document.createElement("div");
  message.className = "empty";
  message.textContent =
    "No studio token. Open the URL printed by `steledb studio` in your terminal — it carries the token in the fragment.";
  mainNode.append(message);
}

async function boot() {
  api.initToken();
  if (!api.hasToken()) {
    showTokenHelp();
    return;
  }
  try {
    await refreshState();
  } catch (error) {
    if (error.status === 403) {
      // a token left over from an earlier run of the studio on this port
      api.forgetToken();
      showTokenHelp();
      return;
    }
    mainNode.replaceChildren();
    const message = document.createElement("div");
    message.className = "empty";
    message.textContent = `Could not reach the studio server: ${error.message}`;
    mainNode.append(message);
    return;
  }
  await applyRoute();
  connectEvents();
}

window.addEventListener("hashchange", () => {
  // Pasting the startup URL into a tab that is already open only changes the
  // fragment, so no reload happens — pick the token up and boot from scratch.
  if (/^#t=/.test(location.hash)) {
    boot().catch((error) => toast(error.message, true));
    return;
  }
  applyRoute().catch((error) => toast(error.message, true));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !drawerNode.hidden) {
    location.hash = routes.table(state.activeTable);
  }
});

boot().catch((error) => toast(error.message, true));
