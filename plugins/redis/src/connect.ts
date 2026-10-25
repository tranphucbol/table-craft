import { connect as connectTcp } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { PluginError, type ConnectOptions } from "@table-craft/plugin-api";
import { createClient, createCluster, RESP_TYPES } from "redis";
import type { RedisConfig } from "./config.js";
import { lowestVersion, requireSupported, versionOfInfo } from "./features.js";
import { connectFailure, tlsOptions } from "./tls.js";

const MS_PER_SECOND = 1000;
const RESP3 = 3;

/** How every command's reply is decoded: bulk strings as bytes, so binary values survive, maps as `Map`. */
export const TYPE_MAPPING = { [RESP_TYPES.BLOB_STRING]: Buffer, [RESP_TYPES.MAP]: Map } as const;

export const SSH_IN_CLUSTER =
  "An SSH tunnel reaches one node; a cluster needs every node. Connect without SSH, or map each node through your own tunnels in Node address map.";

type Argument = string | Buffer;
interface CommandOptions {
  readonly typeMapping?: typeof TYPE_MAPPING;
}

/** The part of a node-redis client the plugin uses; its generics do not survive being stored. */
export interface Client {
  readonly isReady: boolean;
  sendCommand<T = unknown>(args: readonly Argument[], options?: CommandOptions): Promise<T>;
  close(): Promise<void>;
  destroy(): void;
}

interface ClusterNode {
  readonly id: string;
  readonly address: string;
}

/** The part of a node-redis cluster the plugin uses. */
export interface Cluster {
  readonly isOpen: boolean;
  readonly masters: readonly ClusterNode[];
  nodeClient(node: ClusterNode): Promise<Client>;
  getNodeClientForKey(key: Argument): Promise<Client>;
  sendCommand<T = unknown>(
    firstKey: Argument,
    isReadonly: boolean,
    args: Argument[],
    options?: CommandOptions,
  ): Promise<T>;
  close(): Promise<void>;
  destroy(): void;
}

/** A connection to the server or the cluster, and what the plugin needs to reach a node itself. */
export type Connection =
  | { readonly mode: "standalone"; readonly client: Client; readonly address: string; readonly version: string }
  | {
      readonly mode: "cluster";
      readonly cluster: Cluster;
      readonly version: string;
      /** Opens a plain client to a node at the address the client dials, for a replica the cluster does not hold. */
      readonly open: (address: string) => Promise<Client>;
      /** The address the client dials for an announced one, after Node address map. */
      readonly reachable: (announced: string) => string;
    };

/** Node address map: `announced=reachable` pairs, comma or newline separated (decision 4 of plan 058). */
export function parseNodeAddressMap(text: string): ReadonlyMap<string, { host: string; port: number }> {
  const map = new Map<string, { host: string; port: number }>();
  for (const entry of text.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const [announced = "", reachable = ""] = trimmed.split("=").map((part) => part.trim());
    const match = /^(.+):(\d+)$/.exec(reachable);
    if (announced === "" || match === null) {
      throw new PluginError(
        "connectionFailed",
        `Node address map entry "${trimmed}" is not announced=host:port, such as 10.0.1.5:6379=127.0.0.1:7001.`,
      );
    }
    map.set(announced, { host: match[1] ?? "", port: Number(match[2]) });
  }
  return map;
}

function credentials(config: RedisConfig): { username?: string; password?: string } {
  return {
    ...(config.user === "" ? {} : { username: config.user }),
    ...(config.password === "" ? {} : { password: config.password }),
  };
}

function socketOptions(config: RedisConfig, options: ConnectOptions, tls: ConnectionOptions | false) {
  const keepAlive =
    options.keepAliveInitialDelayMs === undefined
      ? {}
      : { keepAlive: true, keepAliveInitialDelay: options.keepAliveInitialDelayMs };
  const common = { connectTimeout: config.connectTimeout * MS_PER_SECOND, reconnectStrategy: false as const };
  return tls === false
    ? { ...common, ...keepAlive, tls: false as const }
    : { ...common, ...keepAlive, ...tls, tls: true as const };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function openStandalone(
  config: RedisConfig,
  options: ConnectOptions,
  host: string,
  port: number,
  tls: ConnectionOptions | false,
  database: number,
): Promise<Client> {
  // Without an error listener node-redis rethrows socket errors; the session reads `isReady` instead.
  const client = createClient({
    socket: { host, port, ...socketOptions(config, options, tls) },
    ...credentials(config),
    database,
    name: config.clientName === "" ? undefined : config.clientName,
    RESP: RESP3,
    disableOfflineQueue: true,
  }).on("error", () => undefined);
  try {
    await client.connect();
  } catch (cause) {
    client.destroy();
    throw cause;
  }
  return client;
}

async function versionOf(client: Client): Promise<string> {
  const info = await client.sendCommand<Buffer | string>(["INFO", "server"]);
  return versionOfInfo(String(info));
}

async function connectStandalone(config: RedisConfig, options: ConnectOptions): Promise<Connection> {
  const tls = await tlsOptions(config, options.serverName);
  let client: Client;
  try {
    client = await openStandalone(config, options, config.host, config.port, tls, config.database);
  } catch (cause) {
    throw connectFailure(config, options.serverName, cause);
  }
  try {
    const version = await versionOf(client);
    requireSupported(version);
    return { mode: "standalone", client, address: `${config.host}:${String(config.port)}`, version };
  } catch (cause) {
    client.destroy();
    throw cause;
  }
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`no answer within ${String(timeoutMs)} ms`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

/** The announced `host:port` of every node in a `CLUSTER NODES` reply. */
export function announcedAddresses(clusterNodes: string): string[] {
  return clusterNodes
    .split("\n")
    .map((line) => line.split(" ")[1]?.split("@")[0] ?? "")
    .filter((address) => address !== "" && !address.startsWith(":"));
}

/**
 * Why a cluster connect failed, said precisely (decision 4 of plan 058): node-redis reports only
 * that the root nodes are unavailable, so the seed is asked directly, then every announced node
 * dialled through Node address map.
 */
async function clusterFailure(
  config: RedisConfig,
  options: ConnectOptions,
  tls: ConnectionOptions | false,
  map: ReadonlyMap<string, { host: string; port: number }>,
  cause: unknown,
): Promise<PluginError> {
  let seed: Client;
  try {
    seed = await openStandalone(config, options, config.host, config.port, tls, 0);
  } catch (seedCause) {
    return connectFailure(config, undefined, seedCause);
  }
  try {
    const nodes = String(await seed.sendCommand<Buffer | string>(["CLUSTER", "NODES"]));
    for (const announced of announcedAddresses(nodes)) {
      const target = map.get(announced);
      const [host = "", port = ""] =
        target === undefined ? announced.split(/:(?=\d+$)/) : [target.host, String(target.port)];
      try {
        await probeTcp(host, Number(port), config.connectTimeout * MS_PER_SECOND);
      } catch (probeCause) {
        const via = target === undefined ? "" : ` (mapped to ${host}:${port})`;
        return new PluginError(
          "connectionFailed",
          `Cannot reach cluster node ${announced}${via}: ${errorMessage(probeCause)}. Add it to Node address map as ${announced}=<host:port you can reach>.`,
          { cause: probeCause },
        );
      }
    }
  } catch (nodesCause) {
    if (/cluster support disabled/i.test(errorMessage(nodesCause))) {
      return new PluginError(
        "connectionFailed",
        `The server at ${config.host}:${String(config.port)} is not part of a cluster. Choose Standalone mode.`,
        { cause: nodesCause },
      );
    }
    return new PluginError("connectionFailed", errorMessage(nodesCause), { cause: nodesCause });
  } finally {
    seed.destroy();
  }
  return new PluginError("connectionFailed", errorMessage(cause), { cause });
}

async function connectCluster(config: RedisConfig, options: ConnectOptions): Promise<Connection> {
  if (options.serverName !== undefined) throw new PluginError("connectionFailed", SSH_IN_CLUSTER);
  const map = parseNodeAddressMap(config.nodeAddressMap);
  const verified = await tlsOptions(config, undefined);
  // Each node is checked against the name it is dialled by, not the seed's.
  const tls =
    verified === false || config.tlsMode !== "verify-full"
      ? verified
      : (({ checkServerIdentity: _check, servername: _name, ...rest }) => rest)(verified);
  const reachable = (announced: string): string => {
    const target = map.get(announced);
    return target === undefined ? announced : `${target.host}:${String(target.port)}`;
  };
  const cluster = createCluster({
    RESP: RESP3,
    rootNodes: [{ socket: { host: config.host, port: config.port } }],
    defaults: {
      ...credentials(config),
      name: config.clientName === "" ? undefined : config.clientName,
      disableOfflineQueue: true,
      socket: socketOptions(config, options, tls),
    },
    nodeAddressMap: (address) => map.get(address),
  }).on("error", () => undefined);
  try {
    await cluster.connect();
  } catch (cause) {
    cluster.destroy();
    throw await clusterFailure(config, options, tls, map, cause);
  }
  try {
    const versions = await Promise.all(
      cluster.masters.map(async (master) => versionOf((await cluster.nodeClient(master)) as unknown as Client)),
    );
    const version = lowestVersion(versions);
    requireSupported(version);
    const open = (address: string): Promise<Client> => {
      const [host = "", port = ""] = address.split(/:(?=\d+$)/);
      return openStandalone(config, options, host, Number(port), tls, 0);
    };
    return { mode: "cluster", cluster: cluster as unknown as Cluster, version, open, reachable };
  } catch (cause) {
    cluster.destroy();
    throw cause;
  }
}

/** Connects in the configured mode, refusing a server older than 6.2 (decision 116). */
export function openConnection(config: RedisConfig, options: ConnectOptions): Promise<Connection> {
  return config.mode === "cluster" ? connectCluster(config, options) : connectStandalone(config, options);
}
