import { COMMAND_FLAGS } from "./subcommands.generated.js";

/** One command as the server's `COMMAND` lists it: flags and where its keys sit among the arguments. */
export interface CommandInfo {
  readonly flags: readonly string[];
  /** Index of the first key in the full argument list (the name is 0); 0 when it takes none. */
  readonly first: number;
  /** Index of the last key; negative counts from the end. */
  readonly last: number;
  readonly step: number;
}

/** The live command table, keyed `SET` or `CONFIG SET`; read once per session and cached. */
export type CommandTable = ReadonlyMap<string, CommandInfo>;

const INFO_FLAGS = 2;
const INFO_FIRST = 3;
const INFO_LAST = 4;
const INFO_STEP = 5;
const INFO_SUBCOMMANDS = 9;

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function infoOf(entry: readonly unknown[]): CommandInfo {
  const flags = entry[INFO_FLAGS];
  return {
    flags: Array.isArray(flags) ? flags.map(text) : [],
    first: Number(entry[INFO_FIRST] ?? 0),
    last: Number(entry[INFO_LAST] ?? 0),
    step: Number(entry[INFO_STEP] ?? 0),
  };
}

function nameOf(entry: readonly unknown[]): string {
  return text(entry[0]).replace("|", " ").toUpperCase();
}

/** The `COMMAND` reply as a table; a 6.2 server lists no subcommands, so those come from the snapshot. */
export function commandTableOf(reply: unknown): CommandTable {
  const table = new Map<string, CommandInfo>();
  for (const entry of Array.isArray(reply) ? reply : []) {
    if (!Array.isArray(entry)) continue;
    table.set(nameOf(entry), infoOf(entry));
    const subcommands: unknown = entry[INFO_SUBCOMMANDS];
    for (const sub of Array.isArray(subcommands) ? subcommands : []) {
      if (Array.isArray(sub)) table.set(nameOf(sub), infoOf(sub));
    }
  }
  return table;
}

/** The table's key for a command's words: the subcommand when the server or the snapshot knows it. */
export function tableKey(table: CommandTable, words: readonly string[]): string {
  const [name = "", second] = words;
  const sub = `${name} ${second ?? ""}`;
  if (second !== undefined && (table.has(sub) || COMMAND_FLAGS[sub] !== undefined)) return sub;
  return name;
}

/** The command's flags: the server's, else the 7.4 snapshot's for a subcommand 6.2 does not list (decision 24). */
export function flagsOf(table: CommandTable, words: readonly string[]): readonly string[] {
  const key = tableKey(table, words);
  return table.get(key)?.flags ?? COMMAND_FLAGS[key] ?? [];
}

/** Commands that change the server or may write without a `write` flag. */
const CHANGES_SERVER: Readonly<Record<string, string>> = {
  "CONFIG SET": "changes the configuration",
  "CONFIG RESETSTAT": "resets statistics",
  "CONFIG REWRITE": "rewrites the configuration file",
  SHUTDOWN: "stops the server",
  DEBUG: "can change the server",
  "SCRIPT FLUSH": "removes cached scripts",
  "SCRIPT LOAD": "loads a script",
  "ACL SETUSER": "changes a user",
  "ACL DELUSER": "deletes a user",
  "ACL LOAD": "reloads users",
  "ACL SAVE": "saves users",
  "CLIENT KILL": "disconnects clients",
  "CLUSTER RESET": "changes the cluster",
  "CLUSTER FAILOVER": "changes the cluster",
  "CLUSTER FORGET": "changes the cluster",
  "CLUSTER MEET": "changes the cluster",
  "MODULE LOAD": "loads a module",
  "MODULE UNLOAD": "unloads a module",
  REPLICAOF: "changes replication",
  SLAVEOF: "changes replication",
  FAILOVER: "changes replication",
  SAVE: "writes a snapshot",
  BGSAVE: "writes a snapshot",
  BGREWRITEAOF: "rewrites the append-only file",
  EVAL: "may write; use EVAL_RO",
  EVALSHA: "may write; use EVALSHA_RO",
  FCALL: "may write; use FCALL_RO",
};

/**
 * Why a read-only session refuses the command (decision 10 of plan 058), or null when it may run:
 * the server's `write` flag, or a command that changes the server itself.
 */
export function readOnlyRefusal(table: CommandTable, words: readonly string[]): string | null {
  const key = tableKey(table, words);
  const reason = CHANGES_SERVER[key] ?? (flagsOf(table, words).includes("write") ? "writes" : null);
  if (reason === null) return null;
  return `read-only datasource refuses ${key}, which ${reason}. Turn off Read-only on the datasource to run it.`;
}

/** The arguments holding keys, from the table's positions; `movable` when only `COMMAND GETKEYS` can tell. */
export function keyArguments<T>(
  table: CommandTable,
  words: readonly string[],
  args: readonly T[],
): readonly T[] | "movable" {
  const key = tableKey(table, words);
  const info = table.get(key);
  if (info === undefined) return [];
  if (info.flags.includes("movablekeys")) return "movable";
  if (info.first <= 0 || info.step <= 0) return [];
  const last = info.last < 0 ? args.length + info.last : info.last;
  const keys: T[] = [];
  for (let index = info.first; index <= last && index < args.length; index += info.step) {
    const value = args[index];
    if (value !== undefined) keys.push(value);
  }
  return keys;
}
