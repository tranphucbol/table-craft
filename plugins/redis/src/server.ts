import type { ServerInfo, ServerInfoSection, SlowCommand } from "@table-craft/plugin-api";
import { commandText } from "./apply.js";
import type { Client } from "./connect.js";

const MS_PER_SECOND = 1000;
/** The `INFO` sections the Server tab shows (decision 20 of plan 058); `INFO` with none answers these too. */
export const INFO_SECTIONS = [
  "server",
  "clients",
  "memory",
  "persistence",
  "stats",
  "replication",
  "cpu",
  "cluster",
  "keyspace",
];

/** What the server questions read through. */
export interface ServerHost {
  readonly mode: "standalone" | "cluster";
  /** The client of a node by `ServerNode.id`, or of one primary for null. */
  clientOf(node: string | null): Promise<{ readonly node: string | null; readonly client: Client }>;
  primaries(): Promise<readonly { readonly node: string; readonly client: Client }[]>;
  /** Whether `INFO` takes several sections (7.0), from the session's features. */
  multiSectionInfo(): Promise<boolean>;
  queued<T>(work: () => Promise<T>): Promise<T>;
}

/** `INFO`'s text as titled sections; on 6.2 one `INFO` answers them all and is split here (decision 24). */
export function infoSections(text: string, wanted: readonly string[] = INFO_SECTIONS): ServerInfoSection[] {
  const sections: { title: string; entries: { name: string; value: string }[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      sections.push({ title: line.slice(1).trim(), entries: [] });
      continue;
    }
    const colon = line.indexOf(":");
    const section = sections.at(-1);
    if (colon > 0 && section !== undefined)
      section.entries.push({ name: line.slice(0, colon), value: line.slice(colon + 1) });
  }
  return sections.filter((section) => wanted.includes(section.title.toLowerCase()));
}

function textOf(value: unknown): string {
  return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value);
}

/** One `SLOWLOG GET` entry: id, unix seconds, microseconds, arguments, then client address and name (4.0). */
export function slowCommandOf(entry: unknown, node: string | null): SlowCommand | null {
  if (!Array.isArray(entry)) return null;
  const [id, at, micros, args, client] = entry as unknown[];
  const words = Array.isArray(args)
    ? args.map((arg) => (arg instanceof Uint8Array ? Buffer.from(arg) : textOf(arg)))
    : [];
  return {
    id: Number(id),
    at: new Date(Number(at) * MS_PER_SECOND).toISOString(),
    durationMicros: Number(micros),
    command: commandText(words),
    client: client === undefined || textOf(client) === "" ? null : textOf(client),
    node,
  };
}

export async function serverInfo(host: ServerHost, node: string | null): Promise<ServerInfo> {
  return host.queued(async () => {
    const target = await host.clientOf(node);
    const args = (await host.multiSectionInfo()) ? ["INFO", ...INFO_SECTIONS] : ["INFO"];
    const text = textOf(await target.client.sendCommand(args));
    return { node: target.node, sections: infoSections(text) };
  });
}

/** The newest `limit` slow commands of one node, or of every primary merged for null. */
export async function slowLog(host: ServerHost, node: string | null, limit: number): Promise<SlowCommand[]> {
  return host.queued(async () => {
    const targets = node === null && host.mode === "cluster" ? await host.primaries() : [await host.clientOf(node)];
    const entries: SlowCommand[] = [];
    for (const target of targets) {
      const reply = await target.client.sendCommand(["SLOWLOG", "GET", String(limit)]);
      for (const entry of Array.isArray(reply) ? reply : []) {
        const command = slowCommandOf(entry, host.mode === "cluster" ? target.node : null);
        if (command !== null) entries.push(command);
      }
    }
    return entries.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, limit);
  });
}
