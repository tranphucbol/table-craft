import { randomUUID } from "node:crypto";
import {
  ConflictError,
  PluginError,
  type KeyApplied,
  type KeyApplyOptions,
  type KeyBytes,
  type KeyChange,
  type KeyName,
} from "@table-craft/plugin-api";
import { TYPE_MAPPING, type Client } from "./connect.js";
import { bytesOf } from "./keyBytes.js";
import { quotedBytes, utf8OrNull } from "./replies.js";
import { quoteArgument } from "./tokens.js";

type Argument = string | Buffer;
type Command = readonly Argument[];

/**
 * What a deleted list element is set to before `LREM` takes every one out: deleting by index
 * one at a time would shift the indexes of the rest (decision 115).
 */
const TOMBSTONE = "__tablecraft_deleted__";
const EVERY_OCCURRENCE = "0";
const COMMAND_OPTIONS = { typeMapping: TYPE_MAPPING };
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

/** Control characters other than tab and line breaks, which `quoteArgument` escapes itself. */
function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === DELETE) return true;
    if (code < FIRST_PRINTABLE && code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN) return true;
  }
  return false;
}

function argumentText(argument: Argument): string {
  if (typeof argument === "string") return quoteArgument(argument);
  const text = utf8OrNull(argument);
  return text !== null && !hasControlCharacters(text) ? quoteArgument(text) : quotedBytes(argument);
}

/** A command as the console would take it back. */
export function commandText(command: Command): string {
  return command.map(argumentText).join(" ");
}

/** The commands that make `changes` to the key, in order (decision 115). */
export function changeCommands(
  key: KeyName,
  changes: readonly KeyChange[],
  options: KeyApplyOptions,
  tombstone = TOMBSTONE,
): Command[] {
  const name = bytesOf(key);
  const sorted = options.type === "zset";
  const commands: Command[] = [];
  let tombstoned = false;
  for (const change of changes) {
    switch (change.kind) {
      case "setString":
        commands.push(["SET", name, bytesOf(change.value), "KEEPTTL"]);
        break;
      case "setField":
        commands.push(["HSET", name, bytesOf(change.field), bytesOf(change.value)]);
        break;
      case "deleteField":
        commands.push(["HDEL", name, bytesOf(change.field)]);
        break;
      case "setIndex":
        commands.push(["LSET", name, String(change.index), bytesOf(change.value)]);
        break;
      case "deleteIndex":
        commands.push(["LSET", name, String(change.index), tombstone]);
        tombstoned = true;
        break;
      case "push":
        commands.push(["RPUSH", name, bytesOf(change.value)]);
        break;
      case "addMember":
        commands.push(sorted ? ["ZADD", name, "0", bytesOf(change.member)] : ["SADD", name, bytesOf(change.member)]);
        break;
      case "deleteMember":
        commands.push([sorted ? "ZREM" : "SREM", name, bytesOf(change.member)]);
        break;
      case "setScore":
        commands.push(["ZADD", name, String(change.score), bytesOf(change.member)]);
        break;
      case "addEntry":
        commands.push([
          "XADD",
          name,
          "*",
          ...change.fields.flatMap(([field, value]) => [bytesOf(field), bytesOf(value)]),
        ]);
        break;
      case "deleteEntry":
        commands.push(["XDEL", name, change.id]);
        break;
    }
  }
  if (tombstoned) commands.push(["LREM", name, EVERY_OCCURRENCE, tombstone]);
  if (options.ttlMs !== undefined) commands.push(["PEXPIRE", name, String(Math.round(options.ttlMs))]);
  return commands;
}

function shown(bytes: KeyBytes): string {
  return bytes.hex === null ? JSON.stringify(bytes.text) : quotedBytes(bytesOf(bytes));
}

function sameBytes(reply: unknown, expected: KeyBytes | null): boolean {
  if (expected === null) return reply === null || reply === undefined;
  return reply instanceof Uint8Array && Buffer.from(reply).equals(bytesOf(expected));
}

function nowText(reply: unknown): string {
  return reply instanceof Uint8Array ? `is now ${argumentText(Buffer.from(reply))}` : "is gone";
}

/** What differs from `change.original`, or null when the element still holds it. */
async function differs(send: (command: Command) => Promise<unknown>, name: Buffer, change: KeyChange) {
  switch (change.kind) {
    case "setString": {
      const now = await send(["GET", name]);
      return sameBytes(now, change.original) ? null : `the value ${nowText(now)}`;
    }
    case "setField":
    case "deleteField": {
      const now = await send(["HGET", name, bytesOf(change.field)]);
      return sameBytes(now, change.original) ? null : `field ${shown(change.field)} ${nowText(now)}`;
    }
    case "setIndex":
    case "deleteIndex": {
      const now = await send(["LINDEX", name, String(change.index)]);
      return sameBytes(now, change.original) ? null : `element ${change.index} ${nowText(now)}`;
    }
    case "setScore": {
      const reply = await send(["ZSCORE", name, bytesOf(change.member)]);
      const now =
        reply === null || reply === undefined ? null : Number(reply instanceof Uint8Array ? String(reply) : reply);
      if (now === change.original) return null;
      return `member ${shown(change.member)} ${now === null ? "is gone" : `now scores ${now}`}`;
    }
    default:
      return null;
  }
}

function typeText(reply: unknown): string {
  return reply instanceof Uint8Array ? Buffer.from(reply).toString("utf8") : String(reply);
}

const SERVER_TYPE_NAMES: Readonly<Record<KeyApplyOptions["type"], string | null>> = {
  string: "string",
  hash: "hash",
  list: "list",
  set: "set",
  zset: "zset",
  stream: "stream",
  json: "ReJSON-RL",
  other: null,
};

/**
 * Runs the changes as one `MULTI` on the connection that holds the key (decision 115). Guarded, it
 * `WATCH`es the key and re-reads every element a change touches first, so a write by anyone else
 * between that check and `EXEC` aborts the transaction as well.
 */
export async function applyChanges(
  client: Client,
  key: KeyName,
  changes: readonly KeyChange[],
  options: KeyApplyOptions,
): Promise<KeyApplied> {
  const name = bytesOf(key);
  const commands = changeCommands(key, changes, options, `${TOMBSTONE}:${randomUUID()}`);
  const send = (command: Command) => client.sendCommand([...command], COMMAND_OPTIONS);
  let watching = false;
  let queued = false;
  try {
    if (options.guard) {
      await send(["WATCH", name]);
      watching = true;
      const type = typeText(await send(["TYPE", name]));
      if (type !== "none" && type !== SERVER_TYPE_NAMES[options.type]) {
        throw new ConflictError(key.text, `it is now a ${type}`);
      }
      for (const change of changes) {
        const detail = await differs(send, name, change);
        if (detail !== null) throw new ConflictError(key.text, detail);
      }
    }
    await send(["MULTI"]);
    queued = true;
    for (const command of commands) await send(command);
    const replies = await send(["EXEC"]);
    queued = false;
    watching = false;
    if (replies === null) throw new ConflictError(key.text, "another client wrote it while the changes ran");
    const failed = (Array.isArray(replies) ? replies : []).findIndex((reply) => reply instanceof Error);
    if (failed >= 0) {
      const command = commands[failed] ?? [];
      const reason = (replies as Error[])[failed]?.message ?? "";
      throw new PluginError(
        "statementFailed",
        `${commandText(command)} failed: ${reason}. Redis ran the other commands; reload the key to see what it holds.`,
      );
    }
    return { commands: commands.map(commandText) };
  } finally {
    if (queued) await send(["DISCARD"]).catch(() => undefined);
    else if (watching) await send(["UNWATCH"]).catch(() => undefined);
  }
}
