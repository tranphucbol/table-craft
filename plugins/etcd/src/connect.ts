import { PluginError, type ConnectOptions } from "@table-craft/plugin-api";
import { EtcdClient, isPermissionDenied } from "./client.js";
import type { EtcdConfig } from "./config.js";
import { connectFailure, grpcTls } from "./tls.js";
import { httpVersion } from "./version.js";

const MS_PER_SECOND = 1000;
const AUTH_REQUIRED = /user name is empty/i;
const AUTH_FAILED = /authentication failed/i;

/** An open client and what connecting learned about the endpoint. */
export interface Connection {
  readonly client: EtcdClient;
  /** `host:port` as dialled. */
  readonly address: string;
  /** Null when neither the status call nor `GET /version` says. */
  readonly version: string | null;
}

function failure(config: EtcdConfig, options: ConnectOptions, cause: unknown): PluginError {
  if (cause instanceof PluginError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (AUTH_REQUIRED.test(message)) {
    return new PluginError("connectionFailed", "This etcd has authentication on: fill in Username and Password.", {
      cause,
    });
  }
  if (AUTH_FAILED.test(message)) {
    return new PluginError("connectionFailed", "etcd refused the Username or Password. Check both and connect again.", {
      cause,
    });
  }
  return connectFailure(config, options.serverName, cause);
}

/**
 * Opens a client on the one endpoint the dialog names and proves it answers (decision 10 of plan
 * 110): the status call, which also authenticates, or, for a user etcd keeps from it, the member list.
 */
export async function openConnection(config: EtcdConfig, options: ConnectOptions): Promise<Connection> {
  const tls = await grpcTls(config, options.serverName);
  const address = `${config.host}:${String(config.port)}`;
  const timeoutMs = config.connectTimeout * MS_PER_SECOND;
  const client = new EtcdClient({
    address,
    tls,
    user: config.user,
    password: config.password,
    maxMessageMb: config.maxMessageMb,
    connectTimeoutMs: timeoutMs,
    ...(options.keepAliveInitialDelayMs === undefined ? {} : { keepAliveMs: options.keepAliveInitialDelayMs }),
  });
  const deadline = () => ({ deadline: Date.now() + timeoutMs });
  try {
    const version = await client.call(async (etcd) => {
      try {
        return (await etcd.maintenance.status(deadline())).version;
      } catch (cause) {
        if (!isPermissionDenied(cause) || AUTH_REQUIRED.test(String(cause))) throw cause;
        await etcd.cluster.memberList({ linearizable: false }, deadline());
        return null;
      }
    });
    return { client, address, version: version ?? (await httpVersion(address, tls, timeoutMs)) };
  } catch (cause) {
    client.close();
    throw failure(config, options, cause);
  }
}
