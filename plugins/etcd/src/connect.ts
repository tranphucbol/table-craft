import { PluginError, type ConnectOptions } from "@table-craft/plugin-api";
import { EtcdClient, isPermissionDenied, type ClientEndpoint, type ClientSettings } from "./client.js";
import { connectionEndpoints, type EtcdConfig } from "./config.js";
import { connectFailure, grpcTls } from "./tls.js";
import { httpVersion } from "./version.js";

const MS_PER_SECOND = 1000;
const AUTH_REQUIRED = /user name is empty/i;
const AUTH_FAILED = /authentication failed/i;

export interface EndpointHealth {
  readonly id: string;
  readonly reachable: boolean;
}

/** An admitted configured-only pool and the initial endpoint health check. */
export interface Connection {
  readonly client: EtcdClient;
  readonly address: string;
  readonly version: string | null;
  readonly clusterId: string;
  readonly endpoints: readonly EndpointHealth[];
  readonly config: EtcdConfig;
}

function failure(config: EtcdConfig, options: ConnectOptions, cause: unknown): PluginError {
  if (cause instanceof PluginError && cause.code === "connectionFailed") return cause;
  let message = cause instanceof Error ? cause.message : String(cause);
  for (const secret of [config.password, config.tlsKeyPassphrase]) {
    if (secret !== "") message = message.split(secret).join("[redacted]");
  }
  if (AUTH_REQUIRED.test(message)) {
    return new PluginError(
      "connectionFailed",
      "This etcd has authentication on: choose an authentication mode and credentials.",
    );
  }
  if (AUTH_FAILED.test(message)) {
    return new PluginError("connectionFailed", "etcd refused the credentials. Check them and connect again.");
  }
  return connectFailure(config, options.serverName, new Error(message));
}

function addressOf(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
}

/** Probes each configured endpoint separately; advertisements are informational, never dial targets. */
export async function openConnection(config: EtcdConfig, options: ConnectOptions): Promise<Connection> {
  const configured = connectionEndpoints(config);
  const transports = options.transports;
  if (config.endpoints.trim() !== "" && options.serverName !== undefined && transports === undefined) {
    throw new PluginError(
      "connectionFailed",
      "Multi-endpoint etcd connections through SSH require authoritative endpoint transports. Update the host and plugin together.",
    );
  }
  if (
    transports !== undefined &&
    (transports.length !== configured.length ||
      configured.some((endpoint) => transports.filter((transport) => transport.id === endpoint.id).length !== 1))
  ) {
    throw new PluginError(
      "connectionFailed",
      "The host did not supply a transport for every configured etcd endpoint.",
    );
  }
  const timeoutMs = config.connectTimeout * MS_PER_SECOND;
  const passwordAuth = config.authMode === "password" || config.authMode === "auto";
  const settings: Omit<ClientSettings, "address" | "tls"> = {
    user: passwordAuth ? config.user : "",
    password: passwordAuth ? config.password : "",
    maxMessageMb: config.maxMessageMb,
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: config.requestTimeout * MS_PER_SECOND,
    maxRequestBytes: config.maxRequestBytes,
    ...(options.keepAliveInitialDelayMs === undefined ? {} : { keepAliveMs: options.keepAliveInitialDelayMs }),
  };
  const admitted: ClientEndpoint[] = [];
  const health: EndpointHealth[] = [];
  let clusterId: string | null = null;
  let version: string | null = null;
  let lastFailure: unknown;
  for (const endpoint of configured) {
    const transport = transports?.find((candidate) => candidate.id === endpoint.id);
    const address = addressOf(transport?.host ?? endpoint.host, transport?.port ?? endpoint.port);
    const tls = await grpcTls(
      { ...config, host: endpoint.host },
      config.serverName || transport?.serverName || options.serverName,
    );
    const probe = new EtcdClient({ ...settings, address, tls, connecting: true });
    let identity: string | undefined;
    try {
      const deadline = () => ({ deadline: Date.now() + timeoutMs });
      const result = await probe.call(async (etcd) => {
        try {
          const status = await etcd.maintenance.status(deadline());
          return { id: status.header.cluster_id, version: status.version };
        } catch (cause) {
          if (!isPermissionDenied(cause) || AUTH_REQUIRED.test(String(cause))) throw cause;
          const members = await etcd.cluster.memberList({ linearizable: false }, deadline());
          return { id: members.header.cluster_id, version: null };
        }
      });
      identity = result.id;
      if (identity === "" || identity === undefined || identity === "0") {
        throw new PluginError(
          "connectionFailed",
          "etcd did not provide a cluster identity; this endpoint cannot be admitted safely.",
        );
      }
      version ??= result.version ?? (await httpVersion(address, tls, timeoutMs));
    } catch (cause) {
      lastFailure = cause;
      health.push({ id: endpoint.id, reachable: false });
      continue;
    } finally {
      probe.close();
    }
    if (clusterId !== null && identity !== clusterId) {
      throw new PluginError(
        "connectionFailed",
        "The configured etcd endpoints belong to different clusters. Correct the endpoint list before reconnecting.",
      );
    }
    clusterId = identity;
    admitted.push({ id: endpoint.id, address, tls });
    health.push({ id: endpoint.id, reachable: true });
  }
  const first = admitted[0];
  if (first === undefined || clusterId === null) throw failure(config, options, lastFailure);
  const client = new EtcdClient({ ...settings, address: first.address, tls: first.tls, endpoints: admitted });
  return { client, address: first.address, version, clusterId, endpoints: health, config };
}
