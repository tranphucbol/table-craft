import { NODE_ALL_PRIMARIES, NODE_AUTO, PluginError, type ServerNode } from "@table-craft/plugin-api";
import { TYPE_MAPPING, type Client, type Connection } from "./connect.js";
import { keyArguments, tableKey, type CommandTable } from "./readOnly.js";
import { asResp3 } from "./resp2.js";
import { replicasOfInfo } from "./sentinel.js";

/** Keyless commands a cluster console runs on every primary unless a node is picked (decision 11 of plan 058). */
const FAN_OUT_BY_DEFAULT = new Set([
  "DBSIZE",
  "INFO",
  "SCAN",
  "KEYS",
  "FLUSHDB",
  "SLOWLOG GET",
  "CLIENT LIST",
  "CONFIG GET",
  "MEMORY STATS",
]);

const COMMAND_OPTIONS = { typeMapping: TYPE_MAPPING };
const RESP2 = 2;
const REDIRECTED = /^(MOVED|ASK) /;
const SELECT_ON_REPLICA = "SELECT switches the console's database on the master; pick the master in Run on.";
const NODE_FIELDS = { id: 0, address: 1, flags: 2, primary: 3, link: 7, slots: 8 } as const;

/** A connection a console command runs on: the node's address and the server's id for it. */
export interface RunningOn {
  readonly address: string;
  readonly clientId: string;
}

/** What a command answered: one reply, or one per primary it fanned out to. */
export type Routed =
  | { readonly fanned: false; readonly reply: unknown }
  | { readonly fanned: true; readonly replies: readonly { readonly node: string; readonly reply: unknown }[] };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One `CLUSTER NODES` line as a `ServerNode`, the address mapped to the one the client dials. */
export function nodeOfLine(line: string, reachable: (announced: string) => string): ServerNode | null {
  const fields = line.trim().split(" ");
  const id = fields[NODE_FIELDS.id] ?? "";
  const announced = (fields[NODE_FIELDS.address] ?? "").split("@")[0] ?? "";
  if (id === "" || announced === "" || announced.startsWith(":")) return null;
  const flags = (fields[NODE_FIELDS.flags] ?? "").split(",");
  const primary = fields[NODE_FIELDS.primary] ?? "-";
  const slots: [number, number][] = [];
  for (const range of fields.slice(NODE_FIELDS.slots)) {
    if (range.startsWith("[")) continue; // a slot being migrated, served by its owner meanwhile
    const [from = "", to = from] = range.split("-");
    slots.push([Number(from), Number(to)]);
  }
  const failed = flags.includes("fail") ? "fail" : flags.includes("fail?") ? "pfail" : null;
  return {
    id,
    address: reachable(announced),
    role: flags.includes("master") ? "primary" : "replica",
    slots,
    primaryId: primary === "-" ? null : primary,
    state: failed ?? fields[NODE_FIELDS.link] ?? "connected",
  };
}

/** Every node of a `CLUSTER NODES` reply, primaries first, each group by address. */
export function nodesOf(clusterNodes: string, reachable: (announced: string) => string): ServerNode[] {
  const nodes = clusterNodes
    .split("\n")
    .map((line) => nodeOfLine(line, reachable))
    .filter((node): node is ServerNode => node !== null);
  const rank = (node: ServerNode): number => (node.role === "primary" ? 0 : 1);
  return nodes.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address, "en", { numeric: true }));
}

/**
 * Where each console command runs (decision 114): the node holding its first key, a picked node,
 * or every primary. node-redis's own cluster routing splits a cross-slot command and merges
 * fanned-out replies; the console wants the server's answer, so commands go to node clients.
 */
export class Router {
  readonly #connection: Connection;
  readonly #table: () => Promise<CommandTable>;
  readonly #database: () => number;
  readonly #replicas = new Map<string, Promise<Client>>();
  readonly #identities = new WeakMap<Client, Promise<RunningOn>>();
  readonly #running = new Set<RunningOn>();

  constructor(connection: Connection, table: () => Promise<CommandTable>, database: () => number = () => 0) {
    this.#connection = connection;
    this.#table = table;
    this.#database = database;
  }

  async nodes(): Promise<ServerNode[]> {
    const connection = this.#connection;
    if (connection.mode === "standalone") {
      const replication = String(await connection.client.sendCommand<Buffer | string>(["INFO", "replication"]));
      const replica = /^role:slave/m.test(replication);
      const server: ServerNode = {
        id: connection.address,
        address: connection.address,
        role: replica ? "replica" : "primary",
        slots: [],
        primaryId: null,
        state: "connected",
      };
      const sentinel = connection.sentinel;
      if (sentinel === undefined) return [server];
      // Sentinel's master announces its replicas; plain Standalone has no map entries for them.
      const replicas = replicasOfInfo(replication).map((found): ServerNode => {
        const address = sentinel.reachable(found.announced);
        return { id: address, address, role: "replica", slots: [], primaryId: connection.address, state: found.state };
      });
      return [server, ...replicas.sort((a, b) => a.address.localeCompare(b.address, "en", { numeric: true }))];
    }
    const text = String(await (await this.#randomPrimary()).sendCommand<Buffer | string>(["CLUSTER", "NODES"]));
    return nodesOf(text, connection.reachable);
  }

  async run(args: readonly Buffer[], words: readonly string[], node: string | undefined): Promise<Routed> {
    const connection = this.#connection;
    const target = node ?? NODE_AUTO;
    if (connection.mode === "standalone") {
      if (target !== NODE_AUTO && target !== NODE_ALL_PRIMARIES && target !== connection.address) {
        if (connection.sentinel === undefined) throw unknownNode(target);
        return { fanned: false, reply: await this.#onReplica(target, args, words) };
      }
      const reply = await this.#console(connection.client, args, connection.address);
      return target === NODE_ALL_PRIMARIES
        ? { fanned: true, replies: [{ node: connection.address, reply }] }
        : { fanned: false, reply };
    }
    const table = await this.#table();
    if (target === NODE_ALL_PRIMARIES || (target === NODE_AUTO && FAN_OUT_BY_DEFAULT.has(tableKey(table, words)))) {
      const replies = await Promise.all(
        (await this.primaries()).map(async ({ node, client }) => ({
          node,
          reply: await this.#console(client, args, node),
        })),
      );
      return { fanned: true, replies };
    }
    if (target !== NODE_AUTO) return { fanned: false, reply: await this.#console(await this.clientOf(target), args) };
    const firstKey = await this.#firstKey(table, words, args);
    if (firstKey === null) return { fanned: false, reply: await this.#console(await this.#randomPrimary(), args) };
    const client = await connection.cluster.getNodeClientForKey(firstKey);
    try {
      return { fanned: false, reply: await this.#console(client, args) };
    } catch (cause) {
      if (!REDIRECTED.test(errorText(cause))) throw cause;
      return {
        fanned: false,
        reply: this.#shaped(args, await connection.cluster.sendCommand(firstKey, false, [...args], COMMAND_OPTIONS)),
      };
    }
  }

  /** Where the console's command is running now, for a cancel to unblock (decision 22 of plan 058). */
  running(): readonly RunningOn[] {
    return [...this.#running];
  }

  /** One command on the node that holds `key`; a slot that moved since the map was read is followed. */
  async onKey(key: Buffer, args: readonly (string | Buffer)[]): Promise<unknown> {
    const connection = this.#connection;
    if (connection.mode === "standalone")
      return this.#shaped(args, await connection.client.sendCommand([...args], COMMAND_OPTIONS));
    const client = await connection.cluster.getNodeClientForKey(key);
    try {
      return this.#shaped(args, await client.sendCommand([...args], COMMAND_OPTIONS));
    } catch (cause) {
      if (!REDIRECTED.test(errorText(cause))) throw cause;
      return this.#shaped(args, await connection.cluster.sendCommand(key, false, [...args], COMMAND_OPTIONS));
    }
  }

  /** The client of the node that holds `key`, for commands that must share one connection. */
  async clientForKey(key: Buffer): Promise<Client> {
    const connection = this.#connection;
    return connection.mode === "standalone" ? connection.client : connection.cluster.getNodeClientForKey(key);
  }

  /** Every primary with its reachable address, by address; the one server when standalone. */
  async primaries(): Promise<{ readonly node: string; readonly client: Client }[]> {
    const connection = this.#connection;
    if (connection.mode === "standalone") return [{ node: connection.address, client: connection.client }];
    const masters = [...connection.cluster.masters].sort((a, b) =>
      a.address.localeCompare(b.address, "en", { numeric: true }),
    );
    return Promise.all(
      masters.map(async (master) => ({
        node: connection.reachable(master.address),
        client: await connection.cluster.nodeClient(master),
      })),
    );
  }

  /** One command on a random primary, routed by nothing: for the plugin's own questions. */
  async anyPrimary(args: readonly (string | Buffer)[]): Promise<unknown> {
    const connection = this.#connection;
    const client = connection.mode === "standalone" ? connection.client : await this.#randomPrimary();
    return this.#shaped(args, await client.sendCommand([...args], COMMAND_OPTIONS));
  }

  /** Closes the replica clients the router opened; the cluster closes its own. */
  async close(): Promise<void> {
    const clients = await Promise.allSettled(this.#replicas.values());
    this.#replicas.clear();
    for (const settled of clients) if (settled.status === "fulfilled") settled.value.destroy();
  }

  async #firstKey(table: CommandTable, words: readonly string[], args: readonly Buffer[]): Promise<Buffer | null> {
    const keys = keyArguments(table, words, args);
    if (keys !== "movable") return keys[0] ?? null;
    try {
      const found = await (
        await this.#randomPrimary()
      ).sendCommand<unknown[]>(["COMMAND", "GETKEYS", ...args], COMMAND_OPTIONS);
      const first = found[0];
      return first instanceof Buffer ? first : null;
    } catch {
      return null; // a call the server finds no keys in, such as EVAL with numkeys 0
    }
  }

  /** A command on a Sentinel replica, in the database the session is on (decision 12 of plan 133). */
  async #onReplica(id: string, args: readonly Buffer[], words: readonly string[]): Promise<unknown> {
    if (words[0] === "SELECT") throw new PluginError("statementFailed", SELECT_ON_REPLICA);
    const client = await this.clientOf(id);
    await client.sendCommand(["SELECT", String(this.#database())]);
    return this.#console(client, args, id);
  }

  /** A RESP2 reply in its RESP3 shape, so both protocols render alike (decision 116). */
  #shaped(args: readonly (string | Buffer)[], reply: unknown): unknown {
    return this.#connection.resp === RESP2 ? asResp3(args, reply) : reply;
  }

  #cluster() {
    if (this.#connection.mode !== "cluster") throw new Error("Not a cluster connection.");
    return this.#connection.cluster;
  }

  async #randomPrimary(): Promise<Client> {
    const cluster = this.#cluster();
    const masters = cluster.masters;
    const master = masters[Math.floor(Math.random() * masters.length)];
    if (master === undefined) throw new PluginError("connectionLost", "The cluster has no reachable primary.");
    return await cluster.nodeClient(master);
  }

  /** A console command, remembered while it runs; the connection's id is asked once, before its first. */
  async #console(client: Client, args: readonly Buffer[], address?: string): Promise<unknown> {
    let identity = this.#identities.get(client);
    if (identity === undefined) {
      identity = this.#identify(client, address);
      identity.catch(() => this.#identities.delete(client));
      this.#identities.set(client, identity);
    }
    const running = await identity;
    this.#running.add(running);
    try {
      return this.#shaped(args, await client.sendCommand([...args], COMMAND_OPTIONS));
    } finally {
      this.#running.delete(running);
    }
  }

  async #identify(client: Client, known: string | undefined): Promise<RunningOn> {
    const clientId = String(await client.sendCommand(["CLIENT", "ID"]));
    return { clientId, address: known ?? (await this.#addressOf(client)) };
  }

  async #addressOf(client: Client): Promise<string> {
    const connection = this.#connection;
    if (connection.mode === "standalone") {
      for (const [id, replica] of this.#replicas) if ((await replica) === client) return id;
      return connection.address;
    }
    for (const master of connection.cluster.masters)
      if ((await connection.cluster.nodeClient(master)) === client) return connection.reachable(master.address);
    for (const [id, replica] of this.#replicas) {
      if ((await replica) !== client) continue;
      const node = (await this.nodes()).find((candidate) => candidate.id === id);
      if (node !== undefined) return node.address;
    }
    throw new PluginError("statementFailed", "The node this command was sent to left the cluster. Run it again.");
  }

  /** The client of a node by its id (`ServerNode.id`), opening a replica's on first use. */
  async clientOf(id: string): Promise<Client> {
    const connection = this.#connection;
    if (connection.mode === "standalone") {
      if (id === connection.address) return connection.client;
      if (connection.sentinel === undefined) throw unknownNode(id);
    } else {
      const cluster = connection.cluster;
      const master = cluster.masters.find((candidate) => candidate.id === id || candidate.address === id);
      if (master !== undefined) return await cluster.nodeClient(master);
    }
    const node = (await this.nodes()).find((candidate) => candidate.id === id);
    if (node === undefined) throw unknownNode(id);
    let client = this.#replicas.get(node.id);
    if (client === undefined) {
      const open = connection.open;
      // READONLY is a cluster command; a Sentinel replica answers reads as it is.
      client =
        connection.mode === "cluster"
          ? open(node.address).then(async (opened) => {
              await opened.sendCommand(["READONLY"]);
              return opened;
            })
          : open(node.address);
      client.catch(() => this.#replicas.delete(node.id));
      this.#replicas.set(node.id, client);
    }
    return client;
  }
}

function unknownNode(id: string): PluginError {
  return new PluginError("statementFailed", `No node ${id} in this datasource. Pick one from the Run on list.`);
}
