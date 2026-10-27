import { PluginError, toWireInteger, type ExecuteResult, type Row } from "@table-craft/plugin-api";
import type { Etcd3, IHashKVResponse, IStatusResponse, MaintenanceClient } from "etcd3";
import { argumentsOf, decimalOf, hexId, leaseIdOf } from "./args.js";
import { isPermissionDenied } from "./client.js";
import type { CommandDoc } from "./docs.js";
import { bytesCell, columnsOf, replyResult, tableResult, utf8OrNull } from "./results.js";
import type { Token } from "./tokens.js";

/** Runs one call on the session's client, with its re-auth retry. */
export type Call = <T>(work: (etcd: Etcd3) => Promise<T>) => Promise<T>;

/** What a cluster, lease or auth command reads besides its arguments. */
export interface AdminHost {
  readonly call: Call;
  /** The endpoint, `host:port`, as dialled. */
  readonly address: string;
}

const HEALTH_KEY = Buffer.from("health");
const MEMBER_COLUMNS = columnsOf(["id", "status", "name", "peer_urls", "client_urls", "is_learner"]);
const STATUS_INTEGERS = ["db_size", "db_size_in_use", "raft_term", "raft_index", "raft_applied_index"];
const STATUS_COLUMNS = columnsOf(
  [
    "endpoint",
    "id",
    "version",
    "db_size",
    "db_size_in_use",
    "is_leader",
    "is_learner",
    "raft_term",
    "raft_index",
    "raft_applied_index",
    "errors",
  ],
  STATUS_INTEGERS,
);
const PERMISSIONS: Readonly<Record<string, string>> = { Read: "read", Write: "write", Readwrite: "readwrite" };

/**
 * `HashKV`, by the method name gRPC's loader gives it: etcd3 asks for `hashKV`, which the loader
 * names `hashKv`, so its own `maintenance.hashKV` always fails.
 */
function hashKv(maintenance: MaintenanceClient): Promise<IHashKVResponse> {
  const { client } = maintenance as unknown as {
    client: { exec(service: string, method: string, payload: unknown): Promise<IHashKVResponse> };
  };
  return client.exec("Maintenance", "hashKv", { revision: 0 });
}

/** The status row of an endpoint, as `etcdctl endpoint status` prints it. */
export function statusRow(address: string, status: IStatusResponse): Row {
  return [
    address,
    hexId(status.header.member_id),
    status.version,
    toWireInteger(status.dbSize),
    toWireInteger(status.dbSizeInUse),
    status.leader === status.header.member_id,
    status.isLearner,
    toWireInteger(status.raftTerm),
    toWireInteger(status.raftIndex),
    toWireInteger(status.raftAppliedIndex),
    status.errors.join(", "),
  ];
}

async function lease(host: AdminHost, doc: CommandDoc, tokens: readonly Token[]): Promise<ExecuteResult> {
  const args = argumentsOf(doc, tokens);
  const first = args.positional[0]?.text ?? "";
  switch (doc.name) {
    case "lease grant": {
      const granted = await host.call((etcd) => etcd.leaseClient.leaseGrant({ TTL: decimalOf(doc, "ttl", first) }));
      const id = hexId(granted.ID);
      return replyResult(id, `lease ${id} granted with TTL(${granted.TTL}s)`);
    }
    case "lease revoke": {
      await host.call((etcd) => etcd.leaseClient.leaseRevoke({ ID: leaseIdOf(doc, first) }));
      return replyResult(first, `lease ${first} revoked`);
    }
    case "lease timetolive": {
      const keys = args.flags.has("keys");
      const live = await host.call((etcd) => etcd.leaseClient.leaseTimeToLive({ ID: leaseIdOf(doc, first), keys }));
      const columns = columnsOf(["id", "ttl", "granted_ttl", ...(keys ? ["keys"] : [])], ["ttl", "granted_ttl"]);
      const row: Row = [
        hexId(live.ID),
        toWireInteger(live.TTL),
        toWireInteger(live.grantedTTL),
        ...(keys ? [live.keys.map((key) => utf8OrNull(key) ?? key.toString("hex")).join(", ")] : []),
      ];
      return tableResult(columns, [row]);
    }
    default: {
      const listed = await host.call((etcd) => etcd.leaseClient.leaseLeases());
      return tableResult(
        columnsOf(["id"]),
        listed.leases.map((entry) => [hexId(entry.ID)]),
      );
    }
  }
}

async function endpoint(host: AdminHost, name: string): Promise<ExecuteResult> {
  switch (name) {
    case "endpoint status": {
      const status = await host.call((etcd) => etcd.maintenance.status());
      return tableResult(STATUS_COLUMNS, [statusRow(host.address, status)]);
    }
    case "endpoint hashkv": {
      const hash = await host.call((etcd) => hashKv(etcd.maintenance));
      return tableResult(columnsOf(["endpoint", "hash", "compact_revision"], ["hash", "compact_revision"]), [
        [host.address, toWireInteger(String(hash.hash)), toWireInteger(hash.compact_revision)],
      ]);
    }
    default: {
      const started = performance.now();
      let health = true;
      let error: string | null = null;
      try {
        await host.call((etcd) => etcd.kv.range({ key: HEALTH_KEY, serializable: false }));
      } catch (cause) {
        // As `etcdctl endpoint health`: a refused read still proves the endpoint answers.
        if (!isPermissionDenied(cause)) {
          health = false;
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      const took = Math.round(performance.now() - started);
      return tableResult(columnsOf(["endpoint", "health", "took_ms", "error"], ["took_ms"]), [
        [host.address, health, took, error],
      ]);
    }
  }
}

async function alarms(host: AdminHost, disarm: boolean): Promise<ExecuteResult> {
  const listed = await host.call((etcd) => etcd.maintenance.alarm({ action: "Get", memberID: 0, alarm: "None" }));
  if (disarm) {
    for (const alarm of listed.alarms) {
      await host.call((etcd) =>
        etcd.maintenance.alarm({ action: "Deactivate", memberID: alarm.memberID, alarm: alarm.alarm }),
      );
    }
  }
  return tableResult(
    columnsOf(["member_id", "alarm"]),
    listed.alarms.map((alarm) => [hexId(alarm.memberID), String(alarm.alarm)]),
  );
}

async function access(host: AdminHost, doc: CommandDoc, tokens: readonly Token[]): Promise<ExecuteResult> {
  const name = argumentsOf(doc, tokens).positional[0]?.text ?? "";
  switch (doc.name) {
    case "user list": {
      const users = await host.call((etcd) => etcd.auth.userList());
      return tableResult(
        columnsOf(["user"]),
        users.users.map((user) => [user]),
      );
    }
    case "user get": {
      const user = await host.call((etcd) => etcd.auth.userGet({ name }));
      return tableResult(
        columnsOf(["user", "role"]),
        user.roles.map((role) => [name, role]),
      );
    }
    case "role list": {
      const roles = await host.call((etcd) => etcd.auth.roleList());
      return tableResult(
        columnsOf(["role"]),
        roles.roles.map((role) => [role]),
      );
    }
    case "role get": {
      const role = await host.call((etcd) => etcd.auth.roleGet({ role: name }));
      return tableResult(
        columnsOf(["role", "permission", "key", "range_end"]),
        role.perm.map((perm) => [
          name,
          PERMISSIONS[String(perm.permType)] ?? String(perm.permType),
          bytesCell(perm.key),
          perm.range_end.length === 0 ? null : bytesCell(perm.range_end),
        ]),
      );
    }
    default: {
      const status = await host.call((etcd) => etcd.auth.authStatus());
      return tableResult(columnsOf(["enabled", "auth_revision"], ["auth_revision"]), [
        [status.enabled, toWireInteger(status.authRevision)],
      ]);
    }
  }
}

/** The member list as `etcdctl member list` prints it. */
export async function memberRows(host: AdminHost): Promise<ExecuteResult> {
  const listed = await host.call((etcd) => etcd.cluster.memberList({ linearizable: true }));
  return tableResult(
    MEMBER_COLUMNS,
    listed.members.map((member) => [
      hexId(member.ID),
      member.name === "" ? "unstarted" : "started",
      member.name,
      member.peerURLs.join(", "),
      member.clientURLs.join(", "),
      member.isLearner,
    ]),
  );
}

/** Runs a command outside the key-value ones: leases, members, endpoint, alarms, defrag and auth. */
export async function runAdmin(host: AdminHost, doc: CommandDoc, tokens: readonly Token[]): Promise<ExecuteResult> {
  argumentsOf(doc, tokens);
  const group = doc.name.split(" ")[0];
  switch (group) {
    case "lease":
      return lease(host, doc, tokens);
    case "member":
      return memberRows(host);
    case "endpoint":
      return endpoint(host, doc.name);
    case "alarm":
      return alarms(host, doc.name === "alarm disarm");
    case "defrag":
      await host.call((etcd) => etcd.maintenance.defragment());
      return replyResult("OK", `Finished defragmenting etcd member[${host.address}]`);
    case "user":
    case "role":
    case "auth":
      return access(host, doc, tokens);
    default:
      throw new PluginError("statementFailed", `${doc.name} is not a command this console runs.`);
  }
}
