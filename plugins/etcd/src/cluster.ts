import type {
  ClusterAlarm,
  ClusterEndpoint,
  ClusterHash,
  ClusterManager,
  ClusterMember,
  ClusterSnapshot,
  ClusterStatus,
} from "@table-craft/plugin-api";
import { EtcdClient, type ClientSettings } from "./client.js";
import type { Connection } from "./connect.js";
import { decimal, invalid, promised, writable, type RuntimeHost } from "./runtime.js";

const MS_PER_SECOND = 1000;
const SNAPSHOT_BUFFER_BYTES = 16_777_216;
const SNAPSHOT_HIGH_WATER_BYTES = 8_388_608;
const SNAPSHOT_LOW_WATER_BYTES = 4_194_304;
const SNAPSHOT_MAX_CHUNKS = 256;
const SNAPSHOT_HIGH_WATER_CHUNKS = 128;
const SNAPSHOT_LOW_WATER_CHUNKS = 64;
const SNAPSHOT_FINAL_STATUS_TIMEOUT_MS = 5000;
/** gRPC status code OK (grpc/doc/statuscodes.md). */
const GRPC_STATUS_OK = 0;
export class EtcdCluster implements ClusterManager {
  constructor(
    readonly host: RuntimeHost,
    readonly connection: Connection,
    readonly createClient: (settings: ClientSettings) => EtcdClient = (settings) => new EtcdClient(settings),
  ) {}
  #pinned(id: string) {
    this.host.state.check();
    return this.connection.client.pinned(id);
  }
  #dedicated(id: string): EtcdClient {
    this.#pinned(id);
    const endpoint = this.connection.client.endpoints.find((entry) => entry.id === id)!;
    const config = this.connection.config;
    const passwordAuth = config.authMode === "auto" || config.authMode === "password";
    return this.createClient({
      address: endpoint.address,
      tls: endpoint.tls,
      user: passwordAuth ? config.user : "",
      password: passwordAuth ? config.password : "",
      maxMessageMb: config.maxMessageMb,
      connectTimeoutMs: config.connectTimeout * MS_PER_SECOND,
      requestTimeoutMs: config.requestTimeout * MS_PER_SECOND,
      maxRequestBytes: config.maxRequestBytes,
    });
  }
  async endpoints(): Promise<readonly ClusterEndpoint[]> {
    return Promise.all(
      this.connection.endpoints.map(async (endpoint): Promise<ClusterEndpoint> => {
        if (!endpoint.reachable)
          return {
            id: endpoint.id,
            label: endpoint.id,
            reachable: false,
            memberId: null,
            error: "Configured endpoint was unreachable during connection admission.",
          };
        try {
          const status = await this.status(endpoint.id);
          return { id: endpoint.id, label: endpoint.id, reachable: true, memberId: status.memberId, error: null };
        } catch {
          return {
            id: endpoint.id,
            label: endpoint.id,
            reachable: false,
            memberId: null,
            error: "Status unavailable. Check the configured endpoint and permissions.",
          };
        }
      }),
    );
  }
  async members(): Promise<readonly ClusterMember[]> {
    this.host.state.check();
    const response = await this.host.globalCall((etcd) => etcd.cluster.memberList({ linearizable: true }));
    if (response.header.cluster_id !== this.host.clusterId)
      invalid("Cluster identity changed. Disconnect before making changes.");
    return response.members.map((member) => ({
      id: member.ID,
      name: member.name,
      learner: member.isLearner,
      peerUrls: member.peerURLs,
      clientUrls: member.clientURLs,
    }));
  }
  async status(endpointId: string): Promise<ClusterStatus> {
    const status = await this.#pinned(endpointId).call((etcd) => etcd.maintenance.status());
    if (status.header.cluster_id !== this.host.clusterId)
      invalid("Configured endpoint changed cluster identity. Disconnect immediately.");
    return {
      endpointId,
      clusterId: status.header.cluster_id,
      memberId: status.header.member_id,
      revision: status.header.revision,
      leaderId: status.leader === "0" ? null : status.leader,
      version: status.version,
      dbBytes: status.dbSize,
      inUseBytes: status.dbSizeInUse,
      quotaBytes: null,
      raftTerm: status.raftTerm,
      raftIndex: status.raftIndex,
      appliedIndex: status.raftAppliedIndex,
    };
  }
  async alarms(): Promise<readonly ClusterAlarm[]> {
    this.host.state.check();
    const response = await this.host.globalCall((etcd) =>
      etcd.maintenance.alarm({ action: "Get", memberID: "0", alarm: "None" }),
    );
    return response.alarms.map((alarm) => ({
      memberId: alarm.memberID,
      kind: alarm.alarm === "Nospace" ? "NOSPACE" : alarm.alarm === "Corrupt" ? "CORRUPT" : "unknown",
    }));
  }
  async disarm(alarm: ClusterAlarm): Promise<void> {
    writable(this.host.readOnly);
    decimal(alarm.memberId, true);
    if (alarm.kind === "unknown") invalid("Unknown alarms cannot be disarmed here.");
    await this.host.globalCall((etcd) =>
      etcd.maintenance.alarm({
        action: "Deactivate",
        memberID: alarm.memberId,
        alarm: alarm.kind === "NOSPACE" ? "Nospace" : "Corrupt",
      }),
    );
  }
  async compact(revision: string, physical: boolean): Promise<void> {
    writable(this.host.readOnly);
    decimal(revision, true);
    this.host.state.check();
    await this.host.globalCall((etcd) => etcd.kv.compact({ revision, physical }));
  }
  async defragment(endpointId: string): Promise<void> {
    writable(this.host.readOnly);
    await this.status(endpointId);
    const client = this.#dedicated(endpointId);
    const release = this.host.state.own(() => promised(() => client.close()));
    try {
      await client.call((etcd) => etcd.maintenance.defragment());
    } finally {
      client.close();
      release();
    }
  }
  async hash(endpointId: string, revision: string): Promise<ClusterHash> {
    decimal(revision);
    await this.status(endpointId);
    const result = await this.#pinned(endpointId).call((etcd) => {
      const maintenance = etcd.maintenance as unknown as {
        client: {
          exec(
            service: string,
            method: string,
            request: unknown,
          ): Promise<{ header: { revision: string }; hash: string; compact_revision: string }>;
        };
      };
      return maintenance.client.exec("Maintenance", "hashKv", { revision });
    });
    return {
      endpointId,
      revision: result.header.revision,
      hash: String(result.hash),
      compactRevision: result.compact_revision,
    };
  }
  async snapshot(endpointId: string): Promise<ClusterSnapshot> {
    await this.status(endpointId);
    const client = this.#dedicated(endpointId);
    let closed = false;
    let ended = false;
    let ok = false;
    let failure: Error | null = null;
    let bytes = 0;
    let paused = false;
    let cancel: (() => void) | undefined;
    let finalStatusTimer: ReturnType<typeof setTimeout> | undefined;
    const queue: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const close = () =>
      promised(() => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        bytes = 0;
        clearTimeout(finalStatusTimer);
        cancel?.();
        client.close();
        notify();
        release();
      });
    const release = this.host.state.own(close);
    try {
      const stream = await client.call((etcd) => etcd.maintenance.snapshot());
      const cancellable = stream as typeof stream & { cancel?: () => void; pause?: () => void; resume?: () => void };
      if (
        typeof cancellable.cancel !== "function" ||
        typeof cancellable.pause !== "function" ||
        typeof cancellable.resume !== "function"
      )
        invalid(
          "The snapshot driver cannot cancel or backpressure its stream. Update the plugin before exporting a snapshot.",
        );
      cancel = () => cancellable.cancel!();
      if (closed) {
        cancel();
        client.close();
        invalid("Snapshot was cancelled before opening.");
      }
      stream.on("data", (response) => {
        if (closed) return;
        if (response.blob.length === 0) return;
        bytes += response.blob.length;
        if (bytes > SNAPSHOT_BUFFER_BYTES || queue.length >= SNAPSHOT_MAX_CHUNKS) {
          failure = new Error("Snapshot consumer exceeded the bounded stream buffer. Start a new snapshot.");
          void close();
          return;
        }
        queue.push(Buffer.from(response.blob));
        if (!paused && (bytes >= SNAPSHOT_HIGH_WATER_BYTES || queue.length >= SNAPSHOT_HIGH_WATER_CHUNKS)) {
          paused = true;
          cancellable.pause!();
        }
        notify();
      });
      stream.on("end", () => {
        if (closed) return;
        ended = true;
        if (!ok && failure === null)
          finalStatusTimer = setTimeout(() => {
            failure = new Error("Snapshot final status was not confirmed; the file must not be published.");
            void close();
          }, SNAPSHOT_FINAL_STATUS_TIMEOUT_MS);
        notify();
      });
      stream.on("status", (status) => {
        if (closed) return;
        clearTimeout(finalStatusTimer);
        if (Number(status.code) === GRPC_STATUS_OK) ok = true;
        else failure = new Error("Snapshot ended without OK status; the file must not be published.");
        notify();
      });
      stream.on("error", () => {
        if (closed) return;
        failure = new Error("Snapshot stream failed; the file must not be published.");
        notify();
      });
      const chunks: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: async function* () {
          try {
            while (true) {
              if (failure !== null) throw failure;
              if (closed) invalid("Snapshot was cancelled; the file must not be published.");
              const chunk = queue.shift();
              if (chunk !== undefined) {
                bytes -= chunk.length;
                if (
                  paused &&
                  bytes <= SNAPSHOT_LOW_WATER_BYTES &&
                  queue.length <= SNAPSHOT_LOW_WATER_CHUNKS &&
                  !ended
                ) {
                  paused = false;
                  cancellable.resume!();
                }
                yield chunk;
                continue;
              }
              if (ended && ok) return;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          } finally {
            await close();
          }
        },
      };
      return { chunks, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
  async #healthy() {
    const members = await this.members();
    const statuses: ClusterStatus[] = [];
    for (const endpoint of this.connection.endpoints)
      if (endpoint.reachable) {
        try {
          statuses.push(await this.status(endpoint.id));
        } catch {
          /* Unreachable configured members cannot count toward quorum. */
        }
      }
    const leaderIds = new Set(statuses.map((status) => status.leaderId));
    if (leaderIds.size !== 1 || leaderIds.has(null))
      invalid("No consistent leader identity. Restore cluster health before changing membership.");
    const leaderId = statuses[0]!.leaderId!;
    const leader = statuses.find((status) => status.memberId === leaderId);
    if (leader === undefined) invalid("Configure a reachable endpoint for the leader before changing membership.");
    return { members, statuses, leader };
  }
  async promote(memberId: string): Promise<void> {
    writable(this.host.readOnly);
    decimal(memberId, true);
    const { members, statuses, leader } = await this.#healthy();
    if (!members.some((member) => member.id === memberId && member.learner)) invalid("Select a current learner.");
    const target = statuses.find((status) => status.memberId === memberId);
    if (
      target === undefined ||
      target.raftTerm !== leader.raftTerm ||
      target.appliedIndex === null ||
      leader.appliedIndex === null ||
      BigInt(target.appliedIndex) < BigInt(leader.appliedIndex)
    )
      invalid("Learner catch-up cannot be verified. Wait and refresh configured endpoint status.");
    await this.host.globalCall((etcd) => etcd.cluster.memberPromote({ ID: memberId }));
  }
  async remove(memberId: string): Promise<void> {
    writable(this.host.readOnly);
    decimal(memberId, true);
    const { members, statuses, leader } = await this.#healthy();
    const target = members.find((member) => member.id === memberId);
    if (target === undefined || memberId === leader.memberId)
      invalid("Cannot remove an unknown member or the current leader. Transfer leadership externally first.");
    const voters = members.filter((member) => !member.learner);
    const remaining = voters.filter((member) => member.id !== memberId);
    const healthy = new Set(
      statuses.filter((status) => status.raftTerm === leader.raftTerm).map((status) => status.memberId),
    );
    const majority = (count: number) => Math.floor(count / 2) + 1;
    if (
      remaining.length === 0 ||
      voters.filter((member) => healthy.has(member.id)).length < majority(voters.length) ||
      remaining.filter((member) => healthy.has(member.id)).length < majority(remaining.length)
    )
      invalid("Removal could lose quorum. Restore configured-member health first.");
    await this.host.globalCall((etcd) => etcd.cluster.memberRemove({ ID: memberId }));
  }
}
