import { NODE_ALL_PRIMARIES, NODE_AUTO, PluginError, type ServerNode } from "@table-craft/plugin-api";
import { TYPE_MAPPING, type Client, type Connection } from "./connect.js";
import { keyArguments, tableKey, type CommandTable } from "./readOnly.js";

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
const REDIRECTED = /^(MOVED|ASK) /;
const NODE_FIELDS = { id: 0, address: 1, flags: 2, primary: 3, link: 7, slots: 8 } as const;

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
  readonly #replicas = new Map<string, Promise<Client>>();

  constructor(connection: Connection, table: () => Promise<CommandTable>) {
    this.#connection = connection;
    this.#table = table;
  }

  async nodes(): Promise<ServerNode[]> {
    const connection = this.#connection;
    if (connection.mode === "standalone") {
      const replication = String(await connection.client.sendCommand<Buffer | string>(["INFO", "replication"]));
      const replica = /^role:slave/m.test(replication);
      return [
        {
          id: connection.address,
          address: connection.address,
          role: replica ? "replica" : "primary",
          slots: [],
          primaryId: null,
          state: "connected",
        },
      ];
    }
    const text = String(await (await this.#randomPrimary()).sendCommand<Buffer | string>(["CLUSTER", "NODES"]));
    return nodesOf(text, connection.reachable);
  }

  async run(args: readonly Buffer[], words: readonly string[], node: string | undefined): Promise<Routed> {
    const connection = this.#connection;
    const target = node ?? NODE_AUTO;
    if (connection.mode === "standalone") {
      if (target !== NODE_AUTO && target !== NODE_ALL_PRIMARIES && target !== connection.address)
        throw unknownNode(target);
      const reply = await connection.client.sendCommand(args, COMMAND_OPTIONS);
      return target === NODE_ALL_PRIMARIES
        ? { fanned: true, replies: [{ node: connection.address, reply }] }
        : { fanned: false, reply };
    }
    const table = await this.#table();
    if (target === NODE_ALL_PRIMARIES || (target === NODE_AUTO && FAN_OUT_BY_DEFAULT.has(tableKey(table, words)))) {
      return { fanned: true, replies: await this.#everyPrimary(args) };
    }
    if (target !== NODE_AUTO)
      return { fanned: false, reply: await (await this.#nodeClient(target)).sendCommand(args, COMMAND_OPTIONS) };
    const firstKey = await this.#firstKey(table, words, args);
    if (firstKey === null)
      return { fanned: false, reply: await (await this.#randomPrimary()).sendCommand(args, COMMAND_OPTIONS) };
    const client = await connection.cluster.getNodeClientForKey(firstKey);
    try {
      return { fanned: false, reply: await client.sendCommand(args, COMMAND_OPTIONS) };
    } catch (cause) {
      // The slot moved since the map was read: let node-redis follow the redirection.
      if (!REDIRECTED.test(errorText(cause))) throw cause;
      return {
        fanned: false,
        reply: await connection.cluster.sendCommand(firstKey, false, [...args], COMMAND_OPTIONS),
      };
    }
  }

  /** One command on a random primary, routed by nothing: for the plugin's own questions. */
  async anyPrimary(args: readonly (string | Buffer)[]): Promise<unknown> {
    const connection = this.#connection;
    const client = connection.mode === "standalone" ? connection.client : await this.#randomPrimary();
    return client.sendCommand([...args], COMMAND_OPTIONS);
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

  async #everyPrimary(args: readonly Buffer[]): Promise<{ node: string; reply: unknown }[]> {
    const cluster = this.#cluster();
    if (this.#connection.mode !== "cluster") return [];
    const reachable = this.#connection.reachable;
    const masters = [...cluster.masters].sort((a, b) => a.address.localeCompare(b.address, "en", { numeric: true }));
    return Promise.all(
      masters.map(async (master) => {
        const client = await cluster.nodeClient(master);
        return { node: reachable(master.address), reply: await client.sendCommand(args, COMMAND_OPTIONS) };
      }),
    );
  }

  async #nodeClient(id: string): Promise<Client> {
    const cluster = this.#cluster();
    const master = cluster.masters.find((candidate) => candidate.id === id || candidate.address === id);
    if (master !== undefined) return await cluster.nodeClient(master);
    const node = (await this.nodes()).find((candidate) => candidate.id === id);
    if (node === undefined || this.#connection.mode !== "cluster") throw unknownNode(id);
    let client = this.#replicas.get(node.id);
    if (client === undefined) {
      const open = this.#connection.open;
      client = open(node.address).then(async (opened) => {
        await opened.sendCommand(["READONLY"]);
        return opened;
      });
      client.catch(() => this.#replicas.delete(node.id));
      this.#replicas.set(node.id, client);
    }
    return client;
  }
}

function unknownNode(id: string): PluginError {
  return new PluginError("statementFailed", `No node ${id} in this datasource. Pick one from the Run on list.`);
}
