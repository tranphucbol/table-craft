import type { UiReply } from "@table-craft/desktop/mcp/toolKit.js";
import { applyAgentEdit } from "@table-craft/desktop/renderer/model/agentEdits.js";
import type {
  McpActiveConsole,
  McpConsoleView,
  McpSchemaOutcome,
  McpUiAnswer,
  McpUiRequest,
  McpUiTarget,
} from "@table-craft/desktop/settings/mcp.js";

export const FAKE_WINDOW_ID = 7;
const DEFAULT_TITLE = "console";

interface FakeConsole {
  readonly handle: string;
  readonly title: string;
  readonly datasourceId: string;
  readonly namespace: readonly string[] | null;
  sql: string;
  selection: { from: number; to: number };
  revision: number;
  client: string | null;
}

/** One TableCraft window as the MCP host sees it: consoles by handle, as the renderer relay keeps them. */
export interface FakeWindow {
  /** Every request the host sent, with the target it named. */
  readonly requests: { readonly target: McpUiTarget; readonly request: McpUiRequest }[];
  open: boolean;
  /** The window takes requests but never answers, as a hung renderer would. */
  silent: boolean;
  active: McpActiveConsole | null;
  /** The schemas a console can switch to; null for a plugin that cannot switch. */
  schemas: readonly string[] | null;
  view(handle: string): McpConsoleView | null;
  typeAsUser(handle: string, sql: string): void;
  closeTab(handle: string): void;
  ask(target: McpUiTarget, request: McpUiRequest): Promise<UiReply>;
}

export function fakeWindow(): FakeWindow {
  const consoles = new Map<string, FakeConsole>();
  let activeHandle: string | null = null;

  function viewOf(entry: FakeConsole): McpConsoleView {
    return {
      handle: entry.handle,
      title: entry.title,
      datasourceId: entry.datasourceId,
      namespace: entry.namespace,
      sql: entry.sql,
      selectionFrom: entry.selection.from,
      selectionTo: entry.selection.to,
      revision: entry.revision,
      active: entry.handle === activeHandle,
    };
  }

  function titleFor(asked: string | null): string {
    const base = asked ?? DEFAULT_TITLE;
    const taken = new Set([...consoles.values()].map((entry) => entry.title));
    if (!taken.has(base)) return base;
    for (let n = 1; ; n++) if (!taken.has(`${base}_${String(n)}`)) return `${base}_${String(n)}`;
  }

  function schemaOutcome(schema: string | null): McpSchemaOutcome | null {
    if (schema === null) return null;
    if (window.schemas === null) return "unsupported";
    return window.schemas.includes(schema) ? "applied" : "unknown";
  }

  function answer(request: McpUiRequest): McpUiAnswer {
    switch (request.kind) {
      case "open": {
        if (request.handle === null) return { kind: "done" };
        const schema = schemaOutcome(request.schema);
        const entry: FakeConsole = {
          handle: request.handle,
          title: titleFor(request.title),
          datasourceId: request.datasourceId,
          namespace: schema === "applied" && request.schema !== null ? [request.schema] : null,
          sql: request.sql,
          selection: { from: request.sql.length, to: request.sql.length },
          revision: 0,
          client: request.client,
        };
        consoles.set(entry.handle, entry);
        activeHandle = entry.handle;
        return { kind: "opened", console: viewOf(entry), schema };
      }
      case "activeContext":
        return { kind: "context", context: window.active };
      case "edit": {
        const entry = consoles.get(request.handle);
        if (entry === undefined) return { kind: "edited", console: null, refusal: null };
        const outcome = applyAgentEdit(entry.sql, entry.revision, request.edit, request.select);
        if (!outcome.ok)
          return {
            kind: "edited",
            console: viewOf(entry),
            refusal: { reason: outcome.reason, index: outcome.index, matches: outcome.matches },
          };
        if (outcome.text !== entry.sql) entry.revision += 1;
        entry.sql = outcome.text;
        entry.selection = { ...outcome.selection };
        if (request.focus) activeHandle = entry.handle;
        return { kind: "edited", console: viewOf(entry), refusal: null };
      }
      case "read":
        return {
          kind: "consoles",
          consoles: request.handles.flatMap((handle) => {
            const entry = consoles.get(handle);
            return entry === undefined ? [] : [viewOf(entry)];
          }),
        };
      case "release":
        for (const handle of request.handles) {
          const entry = consoles.get(handle);
          if (entry !== undefined) entry.client = null;
        }
        return { kind: "done" };
      case "openTable":
      case "reveal":
        return { kind: "done" };
    }
  }

  const window: FakeWindow = {
    requests: [],
    open: true,
    silent: false,
    active: null,
    schemas: ["main"],
    view: (handle) => {
      const entry = consoles.get(handle);
      return entry === undefined ? null : viewOf(entry);
    },
    typeAsUser(handle, sql) {
      const entry = consoles.get(handle);
      if (entry === undefined) throw new Error(`no console ${handle}`);
      entry.sql = sql;
      entry.revision += 1;
    },
    closeTab(handle) {
      consoles.delete(handle);
      if (activeHandle === handle) activeHandle = null;
    },
    ask(target, request) {
      window.requests.push({ target, request });
      if (!window.open) return Promise.resolve({ status: "gone" });
      if (window.silent) return Promise.resolve({ status: "silent" });
      return Promise.resolve({ status: "answered", window: FAKE_WINDOW_ID, answer: answer(request) });
    },
  };
  return window;
}
