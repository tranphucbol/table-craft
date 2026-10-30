import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Etcd3, IOptions } from "../../plugins/etcd/node_modules/etcd3/lib/index.js";

const exec = promisify(execFile);
const driver = createRequire(new URL("../../plugins/etcd/package.json", import.meta.url))("etcd3") as {
  Etcd3: typeof Etcd3;
};
export const ISOLATED_ETCD_IMAGES = {
  "3.5": "gcr.io/etcd-development/etcd:v3.5.21",
  "3.6": "gcr.io/etcd-development/etcd:v3.6.5",
} as const;
const DOCKER_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 200;
const MIN_QUOTA_BYTES = 2 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 64 * 1024 * 1024;
const TMPFS_BYTES = 256 * 1024 * 1024;
const MAX_PORT = 65535;
const SINGLE_MEMBER = 1;
const CLUSTER_MEMBERS = 3;
const LOOPBACK = "127.0.0.1";
const DATA_DIRECTORY = "/var/lib/etcd";
const RESOURCE_PREFIX = "table-craft-etcd-isolated-";
/** Peers dial each other by container name, and Docker's DNS cannot resolve a label over 63 bytes (RFC 1035). */
const MAX_DNS_LABEL = 63;
const DEFAULT_ID_LENGTH = 16;
const CREDENTIALS = {
  root: { username: "root", password: "isolated-root" },
  limited: { username: "limited", password: "isolated-limited" },
} as const;

export interface IsolatedEtcdOptions {
  readonly version?: keyof typeof ISOLATED_ETCD_IMAGES;
  readonly members?: 1 | 3;
  readonly auth?: boolean;
  readonly quotaBytes?: number;
}

export interface IsolatedEtcdMember {
  readonly name: string;
  readonly volume: string;
  readonly endpoint: string;
  readonly peerEndpoint: string;
  readonly internalEndpoint: string;
  readonly port: number;
}

export interface IsolatedEtcdPlan {
  readonly network: string;
  readonly keeper: string;
  readonly image: string;
  readonly quotaBytes: number;
  readonly members: readonly IsolatedEtcdMember[];
}

/** Pure planning: no environment endpoints, compose resources or caller-supplied Docker names. */
export function planIsolatedEtcd(
  options: IsolatedEtcdOptions,
  ports: readonly number[],
  id: string = randomUUID().replaceAll("-", "").slice(0, DEFAULT_ID_LENGTH),
): IsolatedEtcdPlan {
  const count = options.members ?? SINGLE_MEMBER;
  if (count !== SINGLE_MEMBER && count !== CLUSTER_MEMBERS) throw new Error("Use one or three isolated etcd members.");
  if (!/^[a-z0-9-]+$/.test(id) || `${RESOURCE_PREFIX}${id}-${String(count)}`.length > MAX_DNS_LABEL)
    throw new Error("Invalid isolated etcd resource suffix.");
  if (
    ports.length !== count ||
    new Set(ports).size !== count ||
    ports.some((p) => !Number.isInteger(p) || p <= 0 || p > MAX_PORT)
  ) {
    throw new Error("Each isolated etcd member requires a distinct valid host port.");
  }
  const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < MIN_QUOTA_BYTES || quotaBytes > DEFAULT_QUOTA_BYTES) {
    throw new Error("Isolated etcd quota must be between 2 MiB and 64 MiB.");
  }
  const prefix = `${RESOURCE_PREFIX}${id}`;
  return {
    network: `${prefix}-net`,
    keeper: `${prefix}-keeper`,
    image: ISOLATED_ETCD_IMAGES[options.version ?? "3.6"],
    quotaBytes,
    members: ports.map((port, index) => {
      const name = `${prefix}-${String(index + SINGLE_MEMBER)}`;
      return {
        name,
        volume: `${name}-data`,
        endpoint: `http://${LOOPBACK}:${String(port)}`,
        internalEndpoint: `http://${name}:2379`,
        peerEndpoint: `http://${name}:2380`,
        port,
      };
    }),
  };
}

/** Keeps RAM-backed volumes mounted across member stop/start; container tmpfs alone loses data. */
export function isolatedEtcdSetupCommands(plan: IsolatedEtcdPlan): string[][] {
  const cluster = plan.members.map((member) => `${member.name}=${member.peerEndpoint}`).join(",");
  return [
    ["network", "create", plan.network],
    ...plan.members.map((member) => [
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=tmpfs",
      "--opt",
      "device=tmpfs",
      "--opt",
      `o=size=${String(TMPFS_BYTES)}`,
      member.volume,
    ]),
    [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      plan.keeper,
      "--network",
      plan.network,
      "--tmpfs",
      "/keeper",
      ...plan.members.flatMap((member) => ["--mount", `type=volume,src=${member.volume},dst=/hold/${member.name}`]),
      plan.image,
      "/usr/local/bin/etcd",
      "--name=keeper",
      "--data-dir=/keeper",
      "--listen-client-urls=http://127.0.0.1:2379",
      "--advertise-client-urls=http://127.0.0.1:2379",
      "--listen-peer-urls=http://127.0.0.1:2380",
      "--initial-advertise-peer-urls=http://127.0.0.1:2380",
      "--initial-cluster=keeper=http://127.0.0.1:2380",
    ],
    ...plan.members.map((member) => [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      member.name,
      "--network",
      plan.network,
      "--publish",
      `${LOOPBACK}:${String(member.port)}:2379`,
      "--mount",
      `type=volume,src=${member.volume},dst=${DATA_DIRECTORY}`,
      plan.image,
      "/usr/local/bin/etcd",
      `--name=${member.name}`,
      `--data-dir=${DATA_DIRECTORY}`,
      "--listen-client-urls=http://0.0.0.0:2379",
      `--advertise-client-urls=${member.endpoint}`,
      "--listen-peer-urls=http://0.0.0.0:2380",
      `--initial-advertise-peer-urls=${member.peerEndpoint}`,
      `--initial-cluster=${cluster}`,
      `--initial-cluster-token=${plan.network}`,
      `--quota-backend-bytes=${String(plan.quotaBytes)}`,
    ]),
  ];
}

/** Individual commands let cleanup continue even when one resource cannot be removed. */
export function isolatedEtcdCleanupCommands(plan: IsolatedEtcdPlan): string[][] {
  return [
    ...plan.members.map((member) => ["rm", "--force", member.name]),
    ["rm", "--force", plan.keeper],
    ...plan.members.map((member) => ["volume", "rm", member.volume]),
    ["network", "rm", plan.network],
  ];
}

async function docker(args: readonly string[]): Promise<string> {
  return (await exec("docker", [...args], { timeout: DOCKER_TIMEOUT_MS })).stdout.trim();
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a loopback port.");
  return {
    port: address.port,
    release: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export interface IsolatedEtcd {
  readonly plan: IsolatedEtcdPlan;
  readonly credentials: typeof CREDENTIALS | null;
  readonly client: Etcd3;
  /** Each returned client is pinned to one member and closed by fixture cleanup. */
  raw(memberIndex?: number, auth?: IOptions["auth"] | null): Etcd3;
  /** No endpoint override; etcdctl always targets this container's loopback listener. */
  ctl(memberIndex: number, args: readonly string[], auth?: IOptions["auth"] | null): Promise<string>;
  stop(memberIndex: number): Promise<void>;
  start(memberIndex: number): Promise<void>;
  restart(memberIndex: number): Promise<void>;
  waitReady(): Promise<void>;
}

/** Owns every resource from setup through callback failure, including tracked raw clients. */
export async function withIsolatedEtcd<T>(
  options: IsolatedEtcdOptions,
  use: (fixture: IsolatedEtcd) => Promise<T>,
): Promise<T> {
  const reservations: Awaited<ReturnType<typeof reservePort>>[] = [];
  const clients: Etcd3[] = [];
  let plan: IsolatedEtcdPlan | undefined;
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    const count = options.members ?? SINGLE_MEMBER;
    if (count !== SINGLE_MEMBER && count !== CLUSTER_MEMBERS)
      throw new Error("Use one or three isolated etcd members.");
    for (let index = 0; index < count; index += SINGLE_MEMBER) reservations.push(await reservePort());
    plan = planIsolatedEtcd(
      options,
      reservations.map(({ port }) => port),
    );
    for (const command of isolatedEtcdSetupCommands(plan)) {
      if (command[0] === "run" && command.includes("--publish")) {
        const reservation = reservations.shift();
        await reservation?.release();
      }
      await docker(command);
    }
    const owned = plan;
    const memberAt = (index: number) => {
      const member = owned.members[index];
      if (member === undefined) throw new Error(`No isolated etcd member at index ${String(index)}.`);
      return member;
    };
    const defaultAuth = options.auth ? CREDENTIALS.root : undefined;
    const raw = (memberIndex = 0, auth: IOptions["auth"] | null = defaultAuth): Etcd3 => {
      const client = new driver.Etcd3({
        hosts: [memberAt(memberIndex).endpoint],
        ...(auth == null ? {} : { auth }),
        dialTimeout: REQUEST_TIMEOUT_MS,
        defaultCallOptions: (context) => (context.isStream ? {} : { deadline: Date.now() + REQUEST_TIMEOUT_MS }),
      });
      clients.push(client);
      return client;
    };
    const ctl = (memberIndex: number, args: readonly string[], auth: IOptions["auth"] | null = defaultAuth) => {
      if (args.some((arg) => /^--(endpoints|discovery-srv)(=|$)/.test(arg)))
        throw new Error("Isolated etcdctl endpoint overrides are forbidden.");
      return docker([
        "exec",
        memberAt(memberIndex).name,
        "/usr/local/bin/etcdctl",
        "--endpoints=http://127.0.0.1:2379",
        "--command-timeout=3s",
        ...(auth == null ? [] : [`--user=${auth.username}:${auth.password}`]),
        ...args,
      ]);
    };
    let authBootstrapped = false;
    const waitReady = async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          await Promise.all(
            owned.members.map(async (member, index) => {
              if (authBootstrapped) {
                await ctl(index, ["endpoint", "health"]);
                return;
              }
              const response = await fetch(`${member.endpoint}/health`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              });
              if (!response.ok) throw new Error(`Isolated etcd ${member.name} health: ${String(response.status)}`);
            }),
          );
          return;
        } catch (error) {
          lastError = error;
          await delay(POLL_INTERVAL_MS);
        }
      }
      throw new Error("Isolated etcd did not become healthy before the deadline.", { cause: lastError });
    };
    await waitReady();
    if (options.auth) {
      const bootstrap = (args: string[]) => ctl(0, args, null);
      await bootstrap(["user", "add", "root", `--new-user-password=${CREDENTIALS.root.password}`]);
      await bootstrap(["user", "grant-role", "root", "root"]);
      await bootstrap(["role", "add", "limited"]);
      await bootstrap(["role", "grant-permission", "limited", "read", "/app/", "--prefix"]);
      await bootstrap(["user", "add", "limited", `--new-user-password=${CREDENTIALS.limited.password}`]);
      await bootstrap(["user", "grant-role", "limited", "limited"]);
      await bootstrap(["auth", "enable"]);
      authBootstrapped = true;
    }
    result = await use({
      plan: owned,
      credentials: options.auth ? CREDENTIALS : null,
      client: raw(),
      raw,
      ctl,
      waitReady,
      stop: async (index) => {
        await docker(["stop", "--time=5", memberAt(index).name]);
      },
      start: async (index) => {
        await docker(["start", memberAt(index).name]);
      },
      restart: async (index) => {
        await docker(["restart", "--time=5", memberAt(index).name]);
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  const errors: unknown[] = [];
  for (const client of clients) {
    try {
      client.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const reservation of reservations) {
    try {
      await reservation.release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (plan !== undefined) {
    for (const command of isolatedEtcdCleanupCommands(plan)) {
      try {
        await docker(command);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/(No such (container|volume|network)|network .+ not found)/i.test(error.message)
        )
          errors.push(error);
      }
    }
  }
  if (errors.length > 0)
    throw new AggregateError(
      failed ? [failure, ...errors] : errors,
      "Isolated etcd cleanup failed; inspect the named resources.",
    );
  if (failed) throw failure;
  return result as T;
}
