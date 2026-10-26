import type { PluginLoadResult } from "@table-craft/core";
import {
  z,
  type Capability,
  type CommandLanguage,
  type DatasourcePlugin,
  type ExecuteOptions,
  type ExecuteResult,
  type KeySource,
  type KeyType,
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

function sourceOf(key: string, type: KeyType, whole: boolean): KeySource {
  return { database: 0, key: { text: key, hex: null }, type, whole };
}

/**
 * A `commands` plugin over an in-memory map: `GET k`, `SET k v`, `PING`, and the hash `profile`
 * through `HGET k f` and `HGETALL k`; enough to drive the engine. Each read names its source key.
 */
export function fakeCommandsPlugin(capabilities: readonly Capability[] = ["commands"]): {
  loaded: PluginLoadResult;
  calls: FakeCommandsCalls;
} {
  const calls: FakeCommandsCalls = { executed: [], opened: 0 };
  const store = new Map<string, string>([["greeting", "hello"]]);
  const hashes = new Map<string, Map<string, string>>([["profile", new Map([["name", "Ann"]])]]);
  const reply = (text: string, value: string | null, read = false, source?: KeySource): ExecuteResult => ({
    columns: [],
    rows: (async function* () {})(),
    rowsAffected: null,
    reply: { value, text, ...(read ? { read } : {}) },
    ...(source === undefined ? {} : { source }),
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
          const source = found === null ? undefined : sourceOf(key, "string", true);
          return Promise.resolve(reply(found === null ? "(nil)" : JSON.stringify(found), found, true, source));
        }
        case "HGET": {
          const found = hashes.get(key)?.get(value) ?? null;
          const source = hashes.has(key) ? sourceOf(key, "hash", false) : undefined;
          return Promise.resolve(reply(found === null ? "(nil)" : JSON.stringify(found), found, true, source));
        }
        case "HGETALL": {
          const hash = hashes.get(key) ?? new Map<string, string>();
          return Promise.resolve({
            columns: [
              { name: "field", type: null },
              { name: "value", type: null },
            ],
            rows: (async function* () {
              yield* [...hash].map(([field, held]) => [field, held]);
              return Promise.resolve();
            })(),
            rowsAffected: null,
            ...(hashes.has(key) ? { source: sourceOf(key, "hash", true) } : {}),
          });
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
    capabilities: [...capabilities],
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
    manifest: fakeManifest({
      id: FAKE_COMMANDS_ID,
      name: "Commands",
      capabilities: [...capabilities],
      highlight: "redis",
    }),
    plugin,
  };
  return { loaded, calls };
}
