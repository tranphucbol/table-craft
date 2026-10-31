import { PluginError } from "@table-craft/plugin-api";
import type { Client, Protocol } from "./connect.js";

export interface Address {
  readonly host: string;
  readonly port: number;
}

/** A reply the server sends when the login is wrong or missing, as opposed to a network failure. */
const LOGIN_REFUSED = /^(WRONGPASS|NOAUTH|NOPERM)\b|invalid (username-)?password/i;
const NOT_A_SENTINEL = /unknown (sub)?command/i;
/** Where Redis's sample `sentinel.conf` listens. */
const SENTINEL_PORT = 26379;

/**
 * How discovery reaches servers (decision 6 of plan 133): `sentinel` dials a Sentinel with the
 * Sentinel login, `primary` the named master with the data login and the configured database.
 * Passed in so this module stays free of node-redis.
 */
export interface SentinelDial {
  sentinel(address: Address): Promise<Client>;
  primary(address: Address): Promise<{ client: Client; resp: Protocol }>;
}

export interface DiscoveredPrimary {
  readonly client: Client;
  readonly resp: Protocol;
  /** The address dialled, after Node address map. */
  readonly address: string;
}

export function formatAddress(address: Address): string {
  return `${address.host}:${String(address.port)}`;
}

export function parseAddress(text: string): Address | null {
  const match = /^(.+):(\d+)$/.exec(text.trim());
  if (match === null) return null;
  return { host: match[1] ?? "", port: Number(match[2]) };
}

/** Other sentinels: `host:port` entries separated by commas or newlines. */
export function parseSentinels(text: string): readonly Address[] {
  const sentinels: Address[] = [];
  for (const entry of text.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const address = parseAddress(trimmed);
    if (address === null || address.host === "") {
      throw new PluginError(
        "connectionFailed",
        `Other sentinels entry "${trimmed}" is not host:port, such as 10.0.1.6:${String(SENTINEL_PORT)}.`,
      );
    }
    sentinels.push(address);
  }
  return sentinels;
}

export interface ReplicaInfo {
  /** `ip:port` as the primary reports it. */
  readonly announced: string;
  readonly state: string;
}

/** The `slaveN:ip=…,port=…,state=…` lines of a primary's `INFO replication`. */
export function replicasOfInfo(info: string): readonly ReplicaInfo[] {
  const replicas: ReplicaInfo[] = [];
  for (const line of info.split(/\r?\n/)) {
    const match = /^slave\d+:(.*)$/.exec(line.trim());
    if (match === null) continue;
    const fields = new Map(
      (match[1] ?? "").split(",").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)] as const;
      }),
    );
    const ip = fields.get("ip");
    const port = fields.get("port");
    if (ip === undefined || port === undefined) continue;
    replicas.push({ announced: `${ip}:${port}`, state: fields.get("state") ?? "" });
  }
  return replicas;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A `SENTINEL MASTERS` entry's name, in RESP2's flat pairs or RESP3's map. */
function masterNameOf(entry: unknown): string | null {
  if (entry instanceof Map) return entry.has("name") ? String(entry.get("name")) : null;
  if (Array.isArray(entry)) {
    const at = entry.findIndex((item) => String(item) === "name");
    return at === -1 || at + 1 >= entry.length ? null : String(entry[at + 1]);
  }
  if (typeof entry === "object" && entry !== null && "name" in entry) return String(entry.name);
  return null;
}

async function monitoredMasters(client: Client): Promise<readonly string[]> {
  try {
    const masters = await client.sendCommand<unknown>(["SENTINEL", "MASTERS"]);
    return Array.isArray(masters) ? masters.flatMap((entry) => masterNameOf(entry) ?? []) : [];
  } catch {
    return [];
  }
}

async function roleOf(client: Client): Promise<string> {
  const reply = await client.sendCommand<unknown>(["ROLE"]);
  return Array.isArray(reply) ? String(reply[0]) : String(reply);
}

/** What each Sentinel did, so a failed connect can say it in one message. */
class Attempts {
  readonly unanswered: string[] = [];
  readonly refused: string[] = [];
  readonly notSentinels: string[] = [];
  readonly monitored = new Map<string, readonly string[]>();
  readonly replicas: string[] = [];
  unreachable: PluginError | null = null;

  failure(masterName: string): PluginError {
    if (this.unreachable !== null) return this.unreachable;
    if (this.replicas.length > 0) {
      return new PluginError(
        "connectionFailed",
        `The master Sentinel names for ${masterName}, ${this.replicas.join(", ")}, is a replica: a failover is in progress. Connect again in a few seconds.`,
      );
    }
    if (this.monitored.size > 0) {
      const lists = [...this.monitored].map(
        ([sentinel, names]) => `${sentinel} monitors ${names.length === 0 ? "nothing" : names.join(", ")}`,
      );
      return new PluginError(
        "connectionFailed",
        `No Sentinel monitors a master named ${masterName}. ${lists.join("; ")}.`,
      );
    }
    if (this.refused.length > 0) {
      return new PluginError(
        "connectionFailed",
        `Sentinel ${this.refused.join("; ")} refused the login. Fill Sentinel username and password.`,
      );
    }
    if (this.notSentinels.length > 0 && this.unanswered.length === 0) {
      return new PluginError(
        "connectionFailed",
        `${this.notSentinels.join(", ")} is not a Sentinel. Sentinels usually listen on ${String(SENTINEL_PORT)}; or choose Standalone mode.`,
      );
    }
    const others = [...this.unanswered, ...this.notSentinels.map((address) => `${address} (not a Sentinel)`)];
    return new PluginError("connectionFailed", `No Sentinel answered: ${others.join("; ")}.`);
  }
}

async function namedPrimary(
  dial: SentinelDial,
  sentinel: Address,
  masterName: string,
  attempts: Attempts,
): Promise<string | null> {
  const name = formatAddress(sentinel);
  let client: Client;
  try {
    client = await dial.sentinel(sentinel);
  } catch (cause) {
    if (cause instanceof PluginError && cause.code !== "connectionFailed") throw cause;
    const message = messageOf(cause);
    if (LOGIN_REFUSED.test(message)) attempts.refused.push(`${name} (${message})`);
    else if (NOT_A_SENTINEL.test(message)) attempts.notSentinels.push(name);
    else attempts.unanswered.push(`${name} (${message})`);
    return null;
  }
  try {
    const reply = await client.sendCommand<unknown>(["SENTINEL", "GET-MASTER-ADDR-BY-NAME", masterName]);
    if (Array.isArray(reply) && reply.length >= 2) return `${String(reply[0])}:${String(reply[1])}`;
    attempts.monitored.set(name, await monitoredMasters(client));
    return null;
  } catch (cause) {
    const message = messageOf(cause);
    if (LOGIN_REFUSED.test(message)) attempts.refused.push(`${name} (${message})`);
    else if (NOT_A_SENTINEL.test(message)) attempts.notSentinels.push(name);
    else attempts.unanswered.push(`${name} (${message})`);
    return null;
  } finally {
    client.destroy();
  }
}

function unreachablePrimary(masterName: string, announced: string, dialled: string, cause: unknown): PluginError {
  const via = dialled === announced ? "" : ` (mapped to ${dialled})`;
  return new PluginError(
    "connectionFailed",
    `Sentinel names ${announced}${via} the master of ${masterName}, which cannot be reached: ${messageOf(cause)}. Add it to Node address map as ${announced}=<host:port you can reach>.`,
    { cause },
  );
}

/**
 * The primary the Sentinels name for `masterName`, connected and checked with `ROLE`, following
 * Redis's Sentinel client guidelines (https://redis.io/docs/latest/develop/reference/sentinel-clients/):
 * Sentinels in order, each answer mapped through `reachable`. A Sentinel connection closes as soon
 * as it has answered (decision 8 of plan 133).
 */
export async function discoverPrimary(
  dial: SentinelDial,
  sentinels: readonly Address[],
  masterName: string,
  reachable: (announced: string) => string,
): Promise<DiscoveredPrimary> {
  const attempts = new Attempts();
  for (const sentinel of sentinels) {
    const announced = await namedPrimary(dial, sentinel, masterName, attempts);
    if (announced === null) continue;
    const dialled = reachable(announced);
    const address = parseAddress(dialled);
    if (address === null) {
      attempts.unreachable = unreachablePrimary(masterName, announced, dialled, new Error("not host:port"));
      continue;
    }
    let primary: { client: Client; resp: Protocol };
    try {
      primary = await dial.primary(address);
    } catch (cause) {
      if (cause instanceof PluginError || LOGIN_REFUSED.test(messageOf(cause))) throw cause;
      attempts.unreachable = unreachablePrimary(masterName, announced, dialled, cause);
      continue;
    }
    try {
      if ((await roleOf(primary.client)) === "master") return { ...primary, address: dialled };
    } catch (cause) {
      primary.client.destroy();
      throw cause;
    }
    primary.client.destroy();
    attempts.replicas.push(announced);
  }
  throw attempts.failure(masterName);
}

/**
 * The master's client, which drops itself on `READONLY` (decision 9 of plan 133): Sentinel demoted
 * the server while the client stayed connected. The statement fails instead of `connectionLost`,
 * since it was sent and a rerun could land outside its `MULTI`; the next Run finds the client gone
 * and reconnects through the Sentinels.
 */
export function droppedWhenDemoted(client: Client, address: string, masterName: string): Client {
  return {
    get isReady() {
      return client.isReady;
    },
    async sendCommand(args, options) {
      try {
        return await client.sendCommand(args, options);
      } catch (cause) {
        if (!messageOf(cause).startsWith("READONLY")) throw cause;
        client.destroy();
        throw new PluginError(
          "statementFailed",
          `${address} is no longer the master of ${masterName} (READONLY): Sentinel moved it. Run again to reconnect.`,
          { cause },
        );
      }
    },
    close: () => client.close(),
    destroy: () => {
      client.destroy();
    },
  };
}
