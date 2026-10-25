import { COMMAND_DOCS } from "./docs.generated.js";

/** One argument of a command as `COMMAND DOCS` describes it, trimmed to what completion uses. */
export interface DocArgument {
  readonly name: string;
  /** `key`, `string`, `integer`, `double`, `pattern`, `unix-time`, `pure-token`, `oneof` or `block`. */
  readonly type: string;
  /** The literal word that introduces it, such as `EX` or `MATCH`. */
  readonly token?: string;
  readonly optional?: true;
  readonly multiple?: true;
  readonly arguments?: readonly DocArgument[];
}

/** A command's docs, keyed `SET` or `CONFIG SET` (a container's subcommand). */
export interface CommandDoc {
  readonly summary: string;
  readonly since: string;
  readonly group: string;
  readonly arguments?: readonly DocArgument[];
}

export type CommandDocs = ReadonlyMap<string, CommandDoc>;

/** The 7.4 snapshot, for a 6.2 server (no `COMMAND DOCS`, decision 24) and for completing offline. */
export const SNAPSHOT_DOCS: CommandDocs = new Map(Object.entries(COMMAND_DOCS));

/**
 * `docs` narrowed to the commands a server's table lists, by first word, so a 6.2 server is not
 * offered what only the 7.4 snapshot knows (decision 24 of plan 058).
 */
export function docsKnownTo(docs: CommandDocs, commands: ReadonlySet<string>): CommandDocs {
  return new Map([...docs].filter(([key]) => commands.has(key.split(" ")[0] ?? key)));
}

/** Whether `name` is a container whose second word names the command, such as `CONFIG`. */
export function isContainer(docs: CommandDocs, name: string): boolean {
  const prefix = `${name} `;
  for (const key of docs.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/** The docs key for a command's leading words: `CONFIG GET` when `CONFIG` is a container, else `GET`. */
export function docKey(docs: CommandDocs, words: readonly string[]): string | null {
  const name = words[0]?.toUpperCase();
  if (name === undefined) return null;
  const second = words[1]?.toUpperCase();
  if (second !== undefined && docs.has(`${name} ${second}`)) return `${name} ${second}`;
  return docs.has(name) ? name : null;
}

/** One argument as the syntax line prints it: `[EX seconds]`, `<NX | XX>`. */
export function argumentText(argument: DocArgument): string {
  const inner = (() => {
    switch (argument.type) {
      case "pure-token":
        return argument.token ?? argument.name;
      case "oneof":
        return (argument.arguments ?? []).map(argumentText).join(" | ");
      case "block":
        return (argument.arguments ?? []).map(argumentText).join(" ");
      default:
        return argument.token === undefined ? argument.name : `${argument.token} ${argument.name}`;
    }
  })();
  const repeated = argument.multiple === true ? `${inner} [${inner} ...]` : inner;
  if (argument.optional === true) return `[${repeated}]`;
  return argument.type === "oneof" ? `<${repeated}>` : repeated;
}

/** The syntax line of a command, as redis.io prints it: `SET key value [NX | XX] …`. */
export function syntaxOf(name: string, doc: CommandDoc): string {
  return [name, ...(doc.arguments ?? []).map(argumentText)].join(" ");
}

type Reply = unknown;

function field(map: Reply, name: string): Reply {
  return map instanceof Map ? (map as Map<unknown, unknown>).get(name) : undefined;
}

function textOf(value: Reply): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function argumentOf(raw: Reply): DocArgument {
  const flags = field(raw, "flags");
  const list = Array.isArray(flags) ? flags.map(textOf) : [];
  const children = field(raw, "arguments");
  const token = textOf(field(raw, "token"));
  return {
    name: textOf(field(raw, "name")),
    type: textOf(field(raw, "type")),
    ...(token === "" ? {} : { token }),
    ...(list.includes("optional") ? { optional: true as const } : {}),
    ...(list.includes("multiple") ? { multiple: true as const } : {}),
    ...(Array.isArray(children) ? { arguments: children.map(argumentOf) } : {}),
  };
}

function docOf(raw: Reply): CommandDoc {
  const args = field(raw, "arguments");
  return {
    summary: textOf(field(raw, "summary")),
    since: textOf(field(raw, "since")),
    group: textOf(field(raw, "group")),
    ...(Array.isArray(args) ? { arguments: args.map(argumentOf) } : {}),
  };
}

/** `COMMAND DOCS` as the server answers it (a map of maps under RESP3), over the snapshot. */
export function docsFromReply(reply: Reply): CommandDocs {
  const docs = new Map(SNAPSHOT_DOCS);
  if (!(reply instanceof Map)) return docs;
  for (const [rawName, raw] of reply as Map<unknown, unknown>) {
    docs.set(textOf(rawName).replace("|", " ").toUpperCase(), docOf(raw));
    const subcommands = field(raw, "subcommands");
    if (!(subcommands instanceof Map)) continue;
    for (const [sub, subRaw] of subcommands as Map<unknown, unknown>) {
      docs.set(textOf(sub).replace("|", " ").toUpperCase(), docOf(subRaw));
    }
  }
  return docs;
}
