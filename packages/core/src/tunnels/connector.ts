import { PluginError, isPluginError, type ConnectOptions, type Session } from "@table-craft/plugin-api";
import { openSession } from "@table-craft/core/sessions/open.js";
import type { LoadedPlugin, PluginLoadResult } from "@table-craft/core/plugins/loader.js";
import type { HostKeyVerifier } from "@table-craft/core/tunnels/hostKeys.js";
import { createTunnelPool, tunneledSession } from "@table-craft/core/tunnels/pool.js";
import { openTunnel, type SshEndpoint, type Tunnel, type TunnelOptions } from "@table-craft/core/tunnels/tunnel.js";

/** The SSH hop of the tunnel a connector last opened, for Test Connection. */
export interface SshHop {
  readonly host: string;
  readonly user: string;
  readonly elapsedMs: number;
}

export interface ConnectorOptions {
  readonly plugins: readonly PluginLoadResult[];
  readonly pluginId: string;
  readonly config: unknown;
  /** Null, or a plugin whose manifest declares no `network`, connects directly. */
  readonly ssh: SshEndpoint | null;
  readonly verifyHostKey: HostKeyVerifier;
  readonly keepAliveMs?: number;
  readonly now?: () => number;
  readonly openTunnel?: (options: TunnelOptions) => Promise<Tunnel>;
}

/** Opens a data source's sessions, through its SSH tunnel when it has one (decision 070). */
export interface Connector {
  connect(options: ConnectOptions): Promise<Session>;
  /** The hop of the last tunnel opened; null before one opened, and always for a direct connector. */
  readonly hop: SshHop | null;
  /** Closes the tunnel under every session; later connects fail. */
  close(): Promise<void>;
}

const LOOPBACK = "127.0.0.1";
/** Used when the plugin names no timeout field; the built-in plugins default to the same. */
const DEFAULT_TIMEOUT_SECONDS = 10;
const MS_PER_SECOND = 1_000;

type Values = Readonly<Record<string, unknown>>;

function isValues(value: unknown): value is Values {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every session of one data source: direct, or through one tunnel shared by all of them that the
 * last to close takes down. The plugin sees `127.0.0.1` and the forwarded port in the fields its
 * manifest's `network` names, so it never knows the tunnel is there.
 */
export function createConnector(options: ConnectorOptions): Connector {
  const { plugins, pluginId, config, ssh } = options;
  const direct = (connect: ConnectOptions): Promise<Session> => openSession(plugins, pluginId, config, connect);
  const loaded =
    plugins.find((entry): entry is LoadedPlugin => entry.status === "loaded" && entry.manifest.id === pluginId) ?? null;
  const network = loaded?.manifest.connection.network;
  // Without a loaded plugin `direct` fails with the reason, so nothing bypasses the tunnel.
  if (ssh === null || loaded === null || network === undefined) {
    return { connect: direct, hop: null, close: () => Promise.resolve() };
  }

  const parsed = loaded.plugin.connectionSchema.safeParse(config);
  if (!parsed.success || !isValues(parsed.data)) {
    return { connect: direct, hop: null, close: () => Promise.resolve() };
  }
  const values: Values = parsed.data;
  const endpoints = loaded.plugin.connectionEndpoints?.(parsed.data);
  if (endpoints !== undefined) {
    if (endpoints.length === 0 || new Set(endpoints.map((endpoint) => endpoint.id)).size !== endpoints.length) {
      throw new PluginError("connectionFailed", "The plugin supplied an empty or duplicate connection endpoint list.");
    }
    let hop: SshHop | null = null;
    const now = options.now ?? Date.now;
    const open = options.openTunnel ?? openTunnel;
    const seconds =
      network.connectTimeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values[network.connectTimeout]);
    const pools = endpoints.map((target) =>
      createTunnelPool(async () => {
        const started = now();
        const tunnel = await open({
          ssh,
          target,
          verifyHostKey: options.verifyHostKey,
          timeoutMs: (Number.isFinite(seconds) ? seconds : DEFAULT_TIMEOUT_SECONDS) * MS_PER_SECOND,
          ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
        });
        hop = { host: ssh.host, user: ssh.user, elapsedMs: now() - started };
        return tunnel;
      }),
    );
    return {
      async connect(connect) {
        const leases: Awaited<ReturnType<(typeof pools)[number]["acquire"]>>[] = [];
        try {
          for (const pool of pools) leases.push(await pool.acquire());
          const transports = endpoints.map((endpoint, index) => ({
            id: endpoint.id,
            host: LOOPBACK,
            port: leases[index]!.localPort,
            serverName: endpoint.host,
          }));
          let session = await openSession(plugins, pluginId, values, { ...connect, transports });
          for (const lease of leases) session = tunneledSession(session, lease, ssh.host);
          return session;
        } catch (cause) {
          for (const lease of leases) lease.release();
          throw cause;
        }
      },
      get hop() {
        return hop;
      },
      async close() {
        await Promise.all(pools.map((pool) => pool.close()));
      },
    };
  }
  const target = { host: String(values[network.host]), port: Number(values[network.port]) };
  const seconds =
    network.connectTimeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values[network.connectTimeout]);
  const now = options.now ?? Date.now;
  const open = options.openTunnel ?? openTunnel;
  const describe = `${target.host}:${String(target.port)} via ${ssh.host}`;
  let hop: SshHop | null = null;

  const pool = createTunnelPool(async () => {
    const started = now();
    const tunnel = await open({
      ssh,
      target,
      verifyHostKey: options.verifyHostKey,
      timeoutMs: (Number.isFinite(seconds) ? seconds : DEFAULT_TIMEOUT_SECONDS) * MS_PER_SECOND,
      ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
    });
    hop = { host: ssh.host, user: ssh.user, elapsedMs: now() - started };
    return tunnel;
  });

  return {
    async connect(connect) {
      const lease = await pool.acquire();
      const rewritten = { ...values, [network.host]: LOOPBACK, [network.port]: lease.localPort };
      let session: Session;
      try {
        session = await openSession(plugins, pluginId, rewritten, { ...connect, serverName: target.host });
      } catch (cause) {
        lease.release();
        const forwardError = lease.tunnel.forwardError;
        if (forwardError !== null && isPluginError(cause) && cause.code === "connectionFailed") {
          throw new PluginError("connectionFailed", `${forwardError} (${cause.message})`, { cause });
        }
        throw cause;
      }
      return tunneledSession(session, lease, describe);
    },
    get hop() {
      return hop;
    },
    close: () => pool.close(),
  };
}
