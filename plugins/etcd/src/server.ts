import { PluginError, type ServerInfo, type ServerInfoSection, type ServerNode } from "@table-craft/plugin-api";
import type { IAlarmMember, IMember, IStatusResponse } from "etcd3";
import type { AdminHost } from "./admin.js";
import { hexId } from "./args.js";
import { errorText, isPermissionDenied } from "./client.js";

const URL_SCHEME = /^[a-z]+:\/\//i;
const NO_LEADER = "0";

/** A member's address as a client reaches it: its first client URL without the scheme, else its name. */
function addressOf(member: IMember): string {
  const url = member.clientURLs[0];
  return url === undefined ? member.name : url.replace(URL_SCHEME, "");
}

function stateOf(member: IMember): string {
  if (member.name === "") return "unstarted";
  return member.isLearner ? "learner" : "started";
}

/**
 * Every member as a node (decision 9 of plan 110): the leader the connected endpoint reports is
 * the primary, the rest replicas following it.
 */
export function nodesOf(members: readonly IMember[], leader: string | null): ServerNode[] {
  const leaderId = leader === null || leader === NO_LEADER ? null : hexId(leader);
  const nodes = members.map((member): ServerNode => {
    const id = hexId(member.ID);
    const primary = id === leaderId;
    return {
      id,
      address: addressOf(member),
      role: primary ? "primary" : "replica",
      slots: [],
      primaryId: primary ? null : leaderId,
      state: stateOf(member),
    };
  });
  return nodes.sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
}

/** The connected endpoint's status; null when the user may not ask it. */
async function statusOrNull(host: AdminHost): Promise<IStatusResponse | null> {
  try {
    return await host.call((etcd) => etcd.maintenance.status());
  } catch (cause) {
    if (isPermissionDenied(cause)) return null;
    throw cause;
  }
}

export async function nodes(host: AdminHost): Promise<ServerNode[]> {
  const [listed, status] = await Promise.all([
    host.call((etcd) => etcd.cluster.memberList({ linearizable: true })),
    statusOrNull(host),
  ]);
  return nodesOf(listed.members, status?.leader ?? null);
}

function entry(name: string, value: string | number | boolean): { name: string; value: string } {
  return { name, value: String(value) };
}

/** The Server and Storage sections of a status reply. */
export function statusSections(status: IStatusResponse): ServerInfoSection[] {
  return [
    {
      title: "Server",
      entries: [
        entry("version", status.version),
        entry("cluster_id", hexId(status.header.cluster_id)),
        entry("member_id", hexId(status.header.member_id)),
        entry("leader", status.leader === NO_LEADER ? "none" : hexId(status.leader)),
        entry("is_learner", status.isLearner),
        entry("raft_term", status.raftTerm),
        entry("raft_index", status.raftIndex),
        entry("raft_applied_index", status.raftAppliedIndex),
        entry("revision", status.header.revision),
      ],
    },
    {
      title: "Storage",
      entries: [
        entry("db_size", status.dbSize),
        entry("db_size_in_use", status.dbSizeInUse),
        ...(status.errors.length === 0 ? [] : [entry("errors", status.errors.join(", "))]),
      ],
    },
  ];
}

/** The Alarms section: one entry per active alarm, or one saying there is none. */
export function alarmSection(alarms: readonly IAlarmMember[]): ServerInfoSection {
  return {
    title: "Alarms",
    entries:
      alarms.length === 0
        ? [entry("active", "none")]
        : alarms.map((alarm) => entry(hexId(alarm.memberID), String(alarm.alarm))),
  };
}

function refused(what: string, cause: unknown): { name: string; value: string } {
  return entry(what, `left out: ${errorText(cause)}. The datasource's user needs the root role to read it.`);
}

/**
 * What the connected endpoint reports (decision 9 of plan 110). A maintenance call the user may
 * not make leaves its section out and says so in Notes, never failing the whole answer.
 */
export async function serverInfo(host: AdminHost, node: string | null, connected: string | null): Promise<ServerInfo> {
  if (node !== null && connected !== null && node !== connected) {
    throw new PluginError(
      "statementFailed",
      `This datasource reaches member ${connected} only. Add a datasource on member ${node}'s endpoint to see its figures.`,
    );
  }
  const notes: { name: string; value: string }[] = [];
  const sections: ServerInfoSection[] = [];
  try {
    sections.push(...statusSections(await host.call((etcd) => etcd.maintenance.status())));
  } catch (cause) {
    if (!isPermissionDenied(cause)) throw cause;
    notes.push(refused("Server, Storage", cause));
  }
  try {
    const alarms = await host.call((etcd) => etcd.maintenance.alarm({ action: "Get", memberID: 0, alarm: "None" }));
    sections.push(alarmSection(alarms.alarms));
  } catch (cause) {
    if (!isPermissionDenied(cause)) throw cause;
    notes.push(refused("Alarms", cause));
  }
  if (notes.length > 0) sections.push({ title: "Notes", entries: notes });
  return { node, sections };
}

/** The member id of the connected endpoint, hex; null when the user may not ask its status. */
export async function connectedMember(host: AdminHost): Promise<string | null> {
  const status = await statusOrNull(host);
  return status === null ? null : hexId(status.header.member_id);
}
