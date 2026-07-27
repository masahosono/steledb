/** Tiny DOM helpers, so the views can be written as expressions. */

/**
 * el("div", { class: "x", onclick: fn }, child, child)
 * Props starting with "on" become listeners; everything else is an attribute.
 * A null or undefined child is skipped, so `cond && el(...)` works inline.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** A compact one-line rendering of a cell value for the grid. */
export function summarize(value) {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 0
      ? "{}"
      : `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "…" : ""}}`;
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The CSS class describing how a cell value should be styled. */
export function valueClass(value) {
  if (value === undefined) return "cell-absent";
  if (value === null) return "cell-null";
  if (value !== null && typeof value === "object") return "cell-composite";
  return "";
}

/** Comparison used for column sorting: nullish last, then numbers, then strings. */
export function compareValues(a, b) {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Whether a row matches a free-text filter, searched over the whole row's JSON. */
export function rowMatches(row, needle) {
  if (needle === "") return true;
  try {
    return JSON.stringify(row).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}
