import {
  PluginError,
  type ConnectOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type ParameterValue,
  type ServerInfo,
  type ServerNode,
  type Session,
  type SlowCommand,
} from "@table-craft/plugin-api";
import type { Etcd3 } from "etcd3";
import { runAdmin, type AdminHost } from "./admin.js";
import { hexId } from "./args.js";
import { suggestConsoleValues, type ConsoleValueSuggestion } from "./consoleCompletion.js";
import { consoleLeaseId } from "./consoleNumbers.js";
import { errorText, isPermissionDenied } from "./client.js";
import { namespaceBytes, type EtcdConfig } from "./config.js";
import { openConnection, type Connection } from "./connect.js";
import { runCommand, type ConsoleKvGateway } from "./console.js";
import { EtcdAccess } from "./access.js";
import { EtcdCluster } from "./cluster.js";
import { EtcdCoordination } from "./coordination.js";
import { EtcdLeases } from "./leases.js";
import { NamespaceMapper, namespaceCall } from "./namespace.js";
import { RuntimeState, type RuntimeHost } from "./runtime.js";
import { EtcdTransfer } from "./transfer.js";
import { EtcdWatcher } from "./watch.js";
import type { ConsoleIntent } from "./consoleIntent.js";
import { commandOf, type ParameterDoc } from "./docs.js";
import { tokenize } from "./tokens.js";
import { replyResult } from "./results.js";
import { EtcdKeyspace } from "./keyspace.js";
import { utf8OrNull } from "./results.js";
import { NO_END, prefixEnd } from "./scan.js";
import { nodes, serverInfo } from "./server.js";

const BUSY_MESSAGE = "Another command is still running in this session.";
const KEY_COMPLETION_LIMIT = 50;
const NOT_PERMITTED =
  "The datasource's user has no permission for this; ask an etcd admin to grant its role access, or use another user.";

const MS_PER_SECOND = 1000;

/** Scoped KV and global administrative services, with independently closeable stream resources. */
export class EtcdSession implements Session {
  readonly serverVersion: string | null;
  readonly tls = null;
  readonly keyspace: EtcdKeyspace;
  readonly watch: EtcdWatcher;
  readonly leases: EtcdLeases;
  readonly cluster: EtcdCluster;
  readonly access: EtcdAccess;
  readonly coordination: EtcdCoordination;
  readonly keyTransfer: EtcdTransfer;
  readonly #state = new RuntimeState();
  readonly #consoleKv: ConsoleKvGateway;
  readonly #connection: Connection;
  readonly #readOnly: boolean;
  readonly #host: AdminHost;
  #running = false;
  #queue: Promise<unknown> = Promise.resolve();
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  private constructor(connection: Connection, config: EtcdConfig, options: ConnectOptions) {
    this.#connection = connection;
    this.#readOnly = options.readOnly;
    this.serverVersion = connection.version;
    const globalCall = <T>(work: (etcd: Etcd3) => Promise<T>): Promise<T> =>
      this.#failures(() => connection.client.call(work));
    const namespace = new NamespaceMapper(namespaceBytes(config));
    const call = namespaceCall(globalCall, namespace, config.readMode === "serializable");
    this.#host = { call, address: connection.address, namespace };
    const runtime: RuntimeHost = {
      call,
      globalCall,
      namespace,
      state: this.#state,
      readOnly: options.readOnly,
      clusterId: connection.clusterId,
    };
    this.watch = new EtcdWatcher(runtime);
    this.leases = new EtcdLeases(runtime);
    this.cluster = new EtcdCluster(runtime, connection);
    const passwordIdentity = (config.authMode === "auto" || config.authMode === "password") && config.user !== "";
    this.access = new EtcdAccess(
      runtime,
      passwordIdentity ? config.user : null,
      passwordIdentity && config.password !== "",
    );
    this.coordination = new EtcdCoordination(runtime, config.lockPrefix, config.electionPrefix);
    this.keyTransfer = new EtcdTransfer(runtime);
    this.#consoleKv = {
      range: (request) => call((etcd) => etcd.kv.range(request)),
      put: (request) => call((etcd) => etcd.kv.put(request)),
      deleteRange: (request) => call((etcd) => etcd.kv.deleteRange(request)),
      txn: (request) => call((etcd) => etcd.kv.txn(request)),
    };
    this.keyspace = new EtcdKeyspace({
      call,
      runtime,
      delimiter: config.keyDelimiter,
      scanBatch: config.scanBatch,
      readOnly: options.readOnly,
      queued: (work) => this.#queued(work),
    });
    if (config.autoSyncInterval > 0) this.#scheduleRefresh(config, options);
  }

  static async open(config: EtcdConfig, options: ConnectOptions): Promise<EtcdSession> {
    return new EtcdSession(await openConnection(config, options), config, options);
  }

  async execute(sql: string, _params?: readonly ParameterValue[], options?: ExecuteOptions): Promise<ExecuteResult> {
    this.#checkOpen();
    if (this.#running) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    this.#running = true;
    try {
      const host = {
        ...this.#host,
        readOnly: this.#readOnly,
        consoleKv: this.#consoleKv,
        dispatchConsole: (intent: ConsoleIntent) => this.#dispatchConsole(intent, sql.trim()),
      };
      return await runCommand(host, sql.trim(), { fullBytes: options?.fullBytes === true });
    } finally {
      this.#running = false;
    }
  }

  async ping(): Promise<void> {
    this.#checkOpen();
    try {
      await this.#connection.client.call((etcd) => etcd.maintenance.status().catch(() => etcd.cluster.memberList({})));
    } catch (cause) {
      throw new PluginError("connectionLost", errorText(cause), { cause });
    }
  }

  async #dispatchConsole(intent: ConsoleIntent, text: string): Promise<ExecuteResult> {
    if (intent.requiresUi)
      throw new PluginError(
        "statementFailed",
        `${intent.command} requires its managed tool window and confirmation. Open the corresponding Watch, Cluster, Leases or Access tool.`,
      );
    const tokens = tokenize(text);
    const found = commandOf(tokens.map((token) => token.text));
    if (found === null) throw new PluginError("statementFailed", "Unknown administrative command.");
    if (intent.action === "keepAlive") {
      const lease = await this.leases.keepAliveOnce(consoleLeaseId(intent.arguments.positional[0]?.text ?? ""));
      return replyResult(
        lease.remainingTtlSeconds,
        `Lease renewal confirmed, remaining TTL ${lease.remainingTtlSeconds ?? "unknown"}s. Stopping renewal does not revoke the lease.`,
      );
    }
    return runAdmin(this.#host, found.doc, tokens.slice(found.length));
  }

  nodes(): Promise<readonly ServerNode[]> {
    this.#checkOpen();
    return nodes(this.#host);
  }

  async serverInfo(node: string | null): Promise<ServerInfo> {
    this.#checkOpen();
    const endpoints = this.#connection.client.endpoints;
    let endpointId = endpoints[0]!.id;
    if (node !== null) {
      let found = false;
      let denied = 0;
      for (const endpoint of endpoints) {
        try {
          const status = await this.cluster.status(endpoint.id);
          if (hexId(status.memberId) === node) {
            endpointId = endpoint.id;
            found = true;
            break;
          }
        } catch (cause) {
          if (!isPermissionDenied(cause)) throw cause;
          denied += 1;
        }
      }
      // A user refused member status cannot tell members apart; with one endpoint on a one-member
      // cluster there is nothing to tell apart, so its info is read and notes the refused sections.
      if (!found && endpoints.length === 1 && denied === 1) {
        const members = await nodes(this.#host);
        found = members.length === 1 && members[0]!.id === node;
      }
      if (!found)
        throw new PluginError(
          "statementFailed",
          "This member has no reachable configured endpoint with readable status. Configure its endpoint; advertised URLs are never dialled.",
        );
    }
    const pinned = this.#connection.client.pinned(endpointId);
    const info = await serverInfo(
      { ...this.#host, call: (work) => this.#failures(() => pinned.call(work)) },
      node,
      node,
    );
    return {
      ...info,
      sections: [
        ...info.sections,
        {
          title: "Connection",
          entries: [
            { name: "endpoint", value: endpointId },
            {
              name: "read_mode",
              value:
                this.#connection.config.readMode === "serializable" ? "serializable (may be stale)" : "linearizable",
            },
            { name: "namespace_base64", value: this.#host.namespace!.prefix.toString("base64") },
            { name: "namespace_scope", value: "KV only; leases, auth and cluster administration are global" },
          ],
        },
      ],
    };
  }

  /** etcd keeps no slow log a client can read; slow requests go to the server's own log. */
  slowLog(_node: string | null, _limit: number): Promise<readonly SlowCommand[]> {
    return Promise.resolve([]);
  }

  /** Keys starting with `prefix`, at most 50, for completing a key argument. */
  async suggestKeys(prefix: string): Promise<readonly string[]> {
    const key = Buffer.from(prefix, "utf8");
    const response = await this.#host.call((etcd) =>
      etcd.kv.range({
        key: key.length === 0 ? NO_END : key,
        range_end: key.length === 0 ? NO_END : prefixEnd(key),
        keys_only: true,
        limit: KEY_COMPLETION_LIMIT,
      }),
    );
    return response.kvs.flatMap((kv) => {
      const name = utf8OrNull(kv.key);
      return name === null ? [] : [name];
    });
  }

  /** Lease, user, role, member, endpoint and revision values; never through an unscoped KV client. */
  suggestConsoleValues(
    kind: NonNullable<ParameterDoc["completion"]>,
    prefix: string,
  ): Promise<readonly ConsoleValueSuggestion[]> {
    this.#checkOpen();
    return suggestConsoleValues(this, kind, prefix, async () => {
      const result = await this.#host.call((etcd) =>
        etcd.kv.range({ key: NO_END, range_end: NO_END, count_only: true }),
      );
      return result.header.revision;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#refreshTimer);
    this.keyspace.close();
    await this.#state.close();
    this.#connection.client.close();
  }

  #checkOpen(): void {
    if (this.#closed || this.#connection.client.closed)
      throw new PluginError("connectionLost", "The connection to etcd is closed.");
  }

  #scheduleRefresh(config: EtcdConfig, options: ConnectOptions): void {
    this.#refreshTimer = setTimeout(() => {
      void this.#refresh(config, options);
    }, config.autoSyncInterval * MS_PER_SECOND);
    this.#refreshTimer.unref();
  }

  async #refresh(config: EtcdConfig, options: ConnectOptions): Promise<void> {
    if (this.#closed) return;
    let probe: Connection | undefined;
    try {
      probe = await openConnection(config, options);
      if (probe.clusterId !== this.#connection.clusterId) await this.close();
    } catch {
      // Do not replay work or admit a newly advertised endpoint after a refresh failure.
      await this.close();
    } finally {
      probe?.client.close();
      if (!this.#closed) this.#scheduleRefresh(config, options);
    }
  }

  #queued<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => {
      this.#checkOpen();
      return work();
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #failures<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof PluginError) throw cause;
      const message = errorText(cause);
      if (isPermissionDenied(cause))
        throw new PluginError("statementFailed", `${message}. ${NOT_PERMITTED}`, { cause });
      throw new PluginError("statementFailed", message, { cause });
    }
  }
}
