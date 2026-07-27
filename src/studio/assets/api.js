/**
 * The client half of the studio API. The token is handed over in the URL
 * fragment at startup (fragments are never sent to a server, so it stays out of
 * logs and proxies) and then stored, so reloading or bookmarking a deep link
 * keeps working. The key is scoped by port: two studios running side by side
 * must not hand each other's token around.
 */

const TOKEN_KEY = `steledb-studio-token:${location.port}`;

let token = "";

/** Pulls the token out of "#t=…" when present, otherwise reuses the stored one. */
export function initToken() {
  const match = /^#t=(.+)$/.exec(location.hash);
  if (match !== null) {
    token = decodeURIComponent(match[1]);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // private browsing can refuse storage; the token still works for this page
    }
    history.replaceState(null, "", `${location.pathname}#/`);
    return token;
  }
  try {
    token = localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    token = "";
  }
  return token;
}

/** Drops a token the server has rejected, so a stale one is not reused forever. */
export function forgetToken() {
  token = "";
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing to clean up
  }
}

export function hasToken() {
  return token !== "";
}

export function tokenParam() {
  return encodeURIComponent(token);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "X-Steledb-Token": token,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(response.status, `the server returned a non-JSON response: ${text}`);
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `request failed (${response.status})`);
  }
  return payload;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getState() {
  return request("/api/state");
}

export function getTable(tableKey) {
  return request(`/api/table/${encodeURIComponent(tableKey)}`);
}

export function putTable(tableKey, rows, revision) {
  return request(`/api/table/${encodeURIComponent(tableKey)}`, {
    method: "PUT",
    body: JSON.stringify({ rows, revision }),
  });
}

export function getRow(tableKey, rowIndex) {
  return request(`/api/row/${encodeURIComponent(tableKey)}/${rowIndex}`);
}

export function getBlankRow(tableKey) {
  return request(`/api/blank-row/${encodeURIComponent(tableKey)}`);
}

export function lookup(tableKey, column, value) {
  const params = new URLSearchParams({ table: tableKey, column, value: String(value) });
  return request(`/api/lookup?${params.toString()}`);
}

/** Opens the SSE stream. Returns the EventSource so the caller can close it. */
export function openEvents(onMessage, onStatus) {
  const source = new EventSource(`/api/events?token=${tokenParam()}`);
  source.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      // a keep-alive comment or a malformed frame — nothing to do
    }
  };
  source.onopen = () => onStatus(true);
  source.onerror = () => onStatus(false);
  return source;
}
