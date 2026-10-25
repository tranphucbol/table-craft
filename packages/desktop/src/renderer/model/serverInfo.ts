import type { ServerInfo, ServerInfoSection, ServerNode } from "@table-craft/desktop/engine/protocol.js";

/** How often the Server tab reads again, in seconds; 0 is Off (decision 20 of plan 058). */
export const REFRESH_INTERVALS = [0, 2, 5, 10] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

/** How many slow commands the Slow log asks for: `slowlog-max-len`'s default. */
export const SLOW_LOG_LIMIT = 128;

export const SERVER_VIEWS = ["info", "slowLog"] as const;
export type ServerView = (typeof SERVER_VIEWS)[number];

/** The cards, in order, and the figures each leads with; every other entry follows under them. */
const CARDS: readonly { readonly section: string; readonly headline: readonly string[] }[] = [
  {
    section: "Memory",
    headline: ["used_memory_human", "used_memory_peak_human", "maxmemory_human", "mem_fragmentation_ratio"],
  },
  { section: "Clients", headline: ["connected_clients", "blocked_clients"] },
  {
    section: "Stats",
    headline: ["instantaneous_ops_per_sec", "total_commands_processed", "expired_keys", "evicted_keys"],
  },
  { section: "Replication", headline: ["role", "connected_slaves", "master_host", "master_link_status"] },
  { section: "Persistence", headline: ["rdb_changes_since_last_save", "rdb_last_bgsave_status", "aof_enabled"] },
  { section: "Keyspace", headline: [] },
  { section: "Server", headline: ["redis_version", "redis_mode", "uptime_in_days", "os"] },
  { section: "CPU", headline: ["used_cpu_sys", "used_cpu_user"] },
  { section: "Cluster", headline: ["cluster_enabled"] },
];

const HIT_RATIO = "hit ratio";
const MICROS_PER_MS = 1000;
const PERCENT = 100;

export interface Figure {
  readonly name: string;
  readonly value: string;
}

/** One card: its headline figures, then the rest of the section. */
export interface ServerCard {
  readonly title: string;
  readonly headline: readonly Figure[];
  readonly rest: readonly Figure[];
}

function valueOf(section: ServerInfoSection | undefined, name: string): string | null {
  return section?.entries.find((entry) => entry.name === name)?.value ?? null;
}

function sectionOf(info: ServerInfo, title: string): ServerInfoSection | undefined {
  return info.sections.find((section) => section.title === title);
}

/** `keyspace_hits` over hits and misses, as `97.3 %`; null before the first lookup. */
export function hitRatio(stats: ServerInfoSection | undefined): string | null {
  const hits = Number(valueOf(stats, "keyspace_hits") ?? Number.NaN);
  const misses = Number(valueOf(stats, "keyspace_misses") ?? Number.NaN);
  const total = hits + misses;
  if (!Number.isFinite(total) || total === 0) return null;
  return `${((hits / total) * PERCENT).toFixed(1)} %`;
}

/** The sections as cards in the tab's order; a section the plan names no card for comes last. */
export function serverCards(info: ServerInfo): ServerCard[] {
  const known = new Set(CARDS.map((card) => card.section));
  const ordered = [
    ...CARDS.flatMap(({ section, headline }) => {
      const found = sectionOf(info, section);
      return found === undefined ? [] : [{ found, headline }];
    }),
    ...info.sections.filter((section) => !known.has(section.title)).map((found) => ({ found, headline: [] })),
  ];
  return ordered.map(({ found, headline }) => {
    const lead = headline.flatMap((name) => {
      const value = valueOf(found, name);
      return value === null ? [] : [{ name, value }];
    });
    const ratio = found.title === "Stats" ? hitRatio(found) : null;
    return {
      title: found.title,
      headline: ratio === null ? lead : [...lead, { name: HIT_RATIO, value: ratio }],
      rest: found.entries.filter((entry) => !headline.includes(entry.name)),
    };
  });
}

/** A primary's slot ranges as `0–5460, 10923–16383`; empty for a replica or a standalone server. */
export function slotsText(node: ServerNode): string {
  return node.slots.map(([from, to]) => (from === to ? String(from) : `${String(from)}–${String(to)}`)).join(", ");
}

/** One row of a cluster's Overview: every node's role, slots, memory and load. */
export interface OverviewRow {
  readonly node: ServerNode;
  readonly role: string;
  readonly slots: string;
  readonly memory: string | null;
  readonly opsPerSecond: string | null;
}

export function overviewRows(
  nodes: readonly ServerNode[],
  infos: Readonly<Record<string, ServerInfo | undefined>>,
): OverviewRow[] {
  return nodes.map((node) => {
    const info = infos[node.id];
    const primary = nodes.find((candidate) => candidate.id === node.primaryId);
    return {
      node,
      role: node.role === "replica" && primary !== undefined ? `replica of ${primary.address}` : node.role,
      slots: slotsText(node),
      memory: info === undefined ? null : valueOf(sectionOf(info, "Memory"), "used_memory_human"),
      opsPerSecond: info === undefined ? null : valueOf(sectionOf(info, "Stats"), "instantaneous_ops_per_sec"),
    };
  });
}

/** A slow command's duration as `12.5 ms` or `840 µs`. */
export function durationText(micros: number): string {
  return micros < MICROS_PER_MS ? `${String(micros)} µs` : `${(micros / MICROS_PER_MS).toFixed(1)} ms`;
}
