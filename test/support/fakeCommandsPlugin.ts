import type { PluginLoadResult } from "@table-craft/core";
import {
  z,
  type CommandLanguage,
  type DatasourcePlugin,
  type ExecuteOptions,
  type Problem,
  type Session,
  type StatementClass,
  type StatementSpan,
} from "@table-craft/plugin-api";
import { fakeManifest } from "./manifests.js";

export const FAKE_COMMANDS_ID = "commands";
const COMMAND_NAMES = ["GET", "HGET", "KEYS", "PING", "SCAN", "SET", "FLUSHDB"] as const;

/** One command per line; `#` lines and blank lines belong to none. */
function split(text: string): StatementSpan[] {
  const spans: StatementSpan[] = [];
  let from = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const start = from + line.indexOf(trimmed);
      spans.push({ from: start, to: start + trimmed.length, sql: trimmed });
    }
    from += line.length + 1;
  }
  return spans;
}

function classify(command: string): StatementClass {
  const name = command.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (name === "FLUSHDB") return { kind: "write", destructive: "FLUSHDB deletes every key", confirmByName: true };
  if (name === "KEYS") return { kind: "read", destructive: null, costly: "KEYS walks every key" };
  return { kind: name === "SET" ? "write" : "read", destructive: null };
}

const language: CommandLanguage = {
  split,
  classify,
  complete: (request) => {
    const from = request.text.lastIndexOf(" ", request.offset - 1) + 1;
    const typed = request.text.slice(from, request.offset).toUpperCase();
    const items = COMMAND_NAMES.filter((name) => name.startsWith(typed)).map((name) => ({
      label: name,
      kind: "keyword" as const,
      detail: null,
      apply: name,
      boost: 0,
      info: null,
      caret: null,
    }));
    return Promise.resolve({ from, to: request.offset, items, validFor: null });
  },
  inspect: (request) => {
    const problems: Problem[] = split(request.text)
      .filter((span) => classify(span.sql).costly != null)
      .map((span) => ({
        from: span.from,
        to: span.to,
        severity: "warning",
        inspection: "costlyCommand",
        message: "KEYS walks every key",
        fixes: [{ title: "Use SCAN", edits: [{ from: span.from, to: span.to, insert: "SCAN 0" }] }],
      }));
    return Promise.resolve(problems);
  },
};

export interface FakeCommandsCalls {
  /** Every command the plugin ran, with the node it was asked to run on. */
  readonly executed: { command: string; node: string | undefined }[];
  /** How many sessions the plugin opened. */
  opened: number;
}

/** A `commands` plugin over an in-memory map: `GET k`, `SET k v`, `PING`; enough to drive the engine. */
export function fakeCommandsPlugin(): { loaded: PluginLoadResult; calls: FakeCommandsCalls } {
  const calls: FakeCommandsCalls = { executed: [], opened: 0 };
  const store = new Map<string, string>([["greeting", "hello"]]);
  const reply = (text: string, value: string | null) => ({
    columns: [],
    rows: (async function* () {})(),
    rowsAffected: null,
    reply: { value, text },
  });
  const session = (): Session => ({
    execute: (command: string, _parameters?: unknown, options?: ExecuteOptions) => {
      calls.executed.push({ command, node: options?.node });
      const [name, key = "", value = ""] = command.trim().split(/\s+/);
      switch (name?.toUpperCase()) {
        case "PING":
          return Promise.resolve(reply("PONG", "PONG"));
        case "GET": {
          const found = store.get(key) ?? null;
          return Promise.resolve(reply(found === null ? "(nil)" : JSON.stringify(found), found));
        }
        case "SET":
          store.set(key, value);
          return Promise.resolve(reply("OK", "OK"));
        default:
          return Promise.reject(new Error(`ERR unknown command '${name ?? ""}'`));
      }
    },
    close: () => Promise.resolve(),
    serverVersion: "7.4.0",
  });
  const plugin: DatasourcePlugin = {
    id: FAKE_COMMANDS_ID,
    capabilities: ["commands"],
    commandLanguage: language,
    connectionSchema: z.object({}),
    connect: () => {
      calls.opened += 1;
      return Promise.resolve(session());
    },
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/commands",
    manifest: fakeManifest({ id: FAKE_COMMANDS_ID, name: "Commands", capabilities: ["commands"], highlight: "redis" }),
    plugin,
  };
  return { loaded, calls };
}
