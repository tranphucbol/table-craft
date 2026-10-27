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
import type { AdminHost } from "./admin.js";
import { errorText, isPermissionDenied } from "./client.js";
import type { EtcdConfig } from "./config.js";
import { openConnection, type Connection } from "./connect.js";
import { runCommand } from "./console.js";
import { EtcdKeyspace } from "./keyspace.js";
import { utf8OrNull } from "./results.js";
import { NO_END, prefixEnd } from "./scan.js";
import { connectedMember, nodes, serverInfo } from "./server.js";

const BUSY_MESSAGE = "Another command is still running in this session.";
const KEY_COMPLETION_LIMIT = 50;
const NOT_PERMITTED =
  "The datasource's user has no permission for this; ask an etcd admin to grant its role access, or use another user.";

/** What fails the way a lost connection does, so the host may reconnect and run the command again. */
const CONNECTION_LOST = /UNAVAILABLE|No connection established|ECONNREFUSED|ECONNRESET|socket hang up/i;

/**
 * A console and key-tree session on one etcd endpoint (decisions 2 and 11 of plan 110). gRPC
 * calls do not block each other, but the console runs one command at a time and the key tree's
 * calls queue, as the contract asks. It offers no cancel: no command it runs waits on the server,
 * so there is nothing to interrupt, and the contract's cancel suite needs one that sleeps.
 */
export class EtcdSession implements Session {
  readonly serverVersion: string | null;
  readonly tls = null;
  readonly keyspace: EtcdKeyspace;
  readonly #connection: Connection;
  readonly #readOnly: boolean;
  readonly #host: AdminHost;
  #running = false;
  #queue: Promise<unknown> = Promise.resolve();
  #member: Promise<string | null> | undefined;

  private constructor(connection: Connection, config: EtcdConfig, options: ConnectOptions) {
    this.#connection = connection;
    this.#readOnly = options.readOnly;
    this.serverVersion = connection.version;
    const call = <T>(work: (etcd: Etcd3) => Promise<T>): Promise<T> =>
      this.#failures(() => connection.client.call(work));
    this.#host = { call, address: connection.address };
    this.keyspace = new EtcdKeyspace({
      call,
      delimiter: config.keyDelimiter,
      scanBatch: config.scanBatch,
      readOnly: options.readOnly,
      queued: (work) => this.#queued(work),
    });
  }

  static async open(config: EtcdConfig, options: ConnectOptions): Promise<EtcdSession> {
    return new EtcdSession(await openConnection(config, options), config, options);
  }

  async execute(sql: string, _params?: readonly ParameterValue[], options?: ExecuteOptions): Promise<ExecuteResult> {
    this.#checkOpen();
    if (this.#running) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    this.#running = true;
    try {
      const host = { ...this.#host, readOnly: this.#readOnly };
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

  nodes(): Promise<readonly ServerNode[]> {
    this.#checkOpen();
    return nodes(this.#host);
  }

  async serverInfo(node: string | null): Promise<ServerInfo> {
    this.#checkOpen();
    this.#member ??= connectedMember(this.#host).catch(() => null);
    return serverInfo(this.#host, node, await this.#member);
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

  close(): Promise<void> {
    this.#connection.client.close();
    return Promise.resolve();
  }

  #checkOpen(): void {
    if (this.#connection.client.closed) throw new PluginError("connectionLost", "The connection to etcd is closed.");
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
      if (CONNECTION_LOST.test(message)) throw new PluginError("connectionLost", message, { cause });
      if (isPermissionDenied(cause))
        throw new PluginError("statementFailed", `${message}. ${NOT_PERMITTED}`, { cause });
      throw new PluginError("statementFailed", message, { cause });
    }
  }
}
