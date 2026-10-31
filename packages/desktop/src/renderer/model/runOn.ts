import { NODE_ALL_PRIMARIES, NODE_AUTO, type ServerNode } from "@table-craft/desktop/engine/protocol.js";

export interface RunOnChoice {
  readonly value: string;
  readonly label: string;
}

const AUTO_LABEL = "Auto";
const ALL_PRIMARIES_LABEL = "All primaries";

function slotsText(slots: ServerNode["slots"]): string {
  return slots.map(([from, to]) => (from === to ? String(from) : `${String(from)}–${String(to)}`)).join(", ");
}

/** `127.0.0.1:7001 primary 0–5460` or `127.0.0.1:7004 replica of 127.0.0.1:7001`, as the Cluster nodes group reads. */
export function nodeLabel(node: ServerNode, nodes: readonly ServerNode[]): string {
  if (node.role === "replica") {
    const primary = nodes.find((candidate) => candidate.id === node.primaryId);
    return `${node.address} replica of ${primary?.address ?? "?"}`;
  }
  const slots = slotsText(node.slots);
  return slots === "" ? `${node.address} primary` : `${node.address} primary ${slots}`;
}

/** A cluster shares out slots; a primary with replicas lists several nodes and serves none (plan 133). */
export function isCluster(nodes: readonly ServerNode[]): boolean {
  return nodes.length > 1 && nodes.some((node) => node.slots.length > 0);
}

/** What the Run on picker offers (decision 114); nothing when one server is all there is to pick. */
export function runOnChoices(nodes: readonly ServerNode[]): readonly RunOnChoice[] {
  if (nodes.length <= 1) return [];
  return [
    { value: NODE_AUTO, label: AUTO_LABEL },
    ...(isCluster(nodes) ? [{ value: NODE_ALL_PRIMARIES, label: ALL_PRIMARIES_LABEL }] : []),
    ...nodes.map((node) => ({ value: node.id, label: nodeLabel(node, nodes) })),
  ];
}

/** The choice after `current`, wrapping; Auto when `current` is no longer offered. */
export function nextRunOn(choices: readonly RunOnChoice[], current: string): string {
  const index = choices.findIndex((choice) => choice.value === current);
  return choices[(index + 1) % choices.length]?.value ?? NODE_AUTO;
}
