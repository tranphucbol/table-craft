import { PluginError } from "@table-craft/plugin-api";
import { Etcd3, type IOptions } from "etcd3";
import type { GrpcTls } from "./tls.js";

const BYTES_PER_MB = 1024 * 1024;
/** etcd answers pings more often than its `--grpc-keepalive-min-time` (5 s by default) with GOAWAY. */
const MIN_KEEPALIVE_MS = 5000;
/** What etcd answers when the token a call carries is gone: expired, or the auth store moved on (etcd3 #198). */
const STALE_AUTH = /invalid auth token|revision of auth store is old|revision in header is old/i;
const AMBIGUOUS_TRANSPORT =
  /UNAVAILABLE|DEADLINE_EXCEEDED|deadline exceeded|No connection established|ECONNREFUSED|ECONNRESET|socket hang up|RST_STREAM/i;

/** The RPC may have reached the server; never reconnect-and-replay a mutation on this error. */
export class EtcdAmbiguousError extends PluginError {
  readonly outcome = "unknown";

  constructor() {
    super(
      "statementFailed",
      "etcd did not confirm the request before the connection failed or timed out. It may have completed; inspect the current state before trying again.",
    );
  }
}

export interface ClientSettings {
  /** `host:port`, as dialled. */
  readonly address: string;
  readonly tls: GrpcTls | null;
  readonly user: string;
  readonly password: string;
  readonly maxMessageMb: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly connecting?: boolean;
  readonly keepAliveMs?: number;
  readonly endpoints?: readonly ClientEndpoint[];
}

export interface ClientEndpoint {
  readonly id: string;
  readonly address: string;
  readonly tls: GrpcTls | null;
}

type Policy = NonNullable<NonNullable<IOptions["faultHandling"]>["global"]>;

/**
 * Runs each call once: etcd3's default retries a failed call three times and opens a circuit
 * breaker after three failures, which turns one clear error into a slow, vaguer one.
 */
const ONCE = { execute: async <T>(work: () => T | Promise<T>): Promise<T> => work() } as unknown as Policy;

interface SslFactory {
  createSsl(
    rootCerts: Buffer | null,
    privateKey: Buffer | null,
    certChain: Buffer | null,
    verify: Pick<GrpcTls, "rejectUnauthorized" | "checkServerIdentity">,
  ): unknown;
}

interface PoolInternals {
  readonly hosts?: readonly { channelCredentials: object }[];
  readonly authenticator?: { credentials: object };
}

/**
 * Puts gRPC credentials that check the server as the TLS mode says on every configured host.
 * etcd3 builds its credentials from CA, key and chain alone, so it can neither skip verification
 * (`require`) nor skip the name check (`verify-ca`); its pool is reached into before the first
 * call, and the factory taken from etcd3's own credentials so both come from the same gRPC copy.
 */
function useTls(etcd: Etcd3, tls: GrpcTls): void {
  const pool = (etcd as unknown as { pool?: PoolInternals }).pool;
  const hosts = pool?.hosts;
  const authenticator = pool?.authenticator;
  if (hosts === undefined || hosts.length === 0 || authenticator === undefined) {
    throw new PluginError(
      "connectionFailed",
      "This build of the etcd3 driver keeps its connections differently; TLS cannot be set up. Report it with the plugin's version.",
    );
  }
  const factory = hosts[0]!.channelCredentials.constructor as unknown as SslFactory;
  const credentials = factory.createSsl(tls.rootCertificate, tls.privateKey, tls.certChain, {
    rejectUnauthorized: tls.rejectUnauthorized,
    checkServerIdentity: tls.checkServerIdentity,
  }) as object;
  for (const host of hosts) host.channelCredentials = credentials;
  authenticator.credentials = credentials;
}

function createEtcd(settings: ClientSettings): Etcd3 {
  const scheme = settings.tls === null ? "http" : "https";
  const serverName = settings.tls?.serverName ?? null;
  const keepAlive =
    settings.keepAliveMs === undefined
      ? {}
      : { "grpc.keepalive_time_ms": Math.max(settings.keepAliveMs, MIN_KEEPALIVE_MS) };
  const etcd = new Etcd3({
    hosts: [`${scheme}://${settings.address}`],
    dialTimeout: settings.connectTimeoutMs,
    defaultCallOptions: (context) =>
      context.isStream ? {} : { deadline: Date.now() + (settings.requestTimeoutMs ?? settings.connectTimeoutMs) },
    ...(settings.user === "" && settings.password === ""
      ? {}
      : {
          auth: {
            username: settings.user,
            password: settings.password,
            callOptions: () => ({ deadline: Date.now() + settings.connectTimeoutMs }),
          },
        }),
    grpcOptions: {
      "grpc.max_receive_message_length": settings.maxMessageMb * BYTES_PER_MB,
      "grpc.max_send_message_length": Math.min(
        settings.maxMessageMb * BYTES_PER_MB,
        settings.maxRequestBytes ?? Infinity,
      ),
      ...keepAlive,
      ...(serverName === null
        ? {}
        : { "grpc.ssl_target_name_override": serverName, "grpc.default_authority": serverName }),
    },
    faultHandling: { global: ONCE, host: () => ONCE },
  });
  if (settings.tls !== null) useTls(etcd, settings.tls);
  return etcd;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether etcd refused the call for the caller's permissions, not for what it asked. */
export function isPermissionDenied(cause: unknown): boolean {
  return /permission denied|user name is empty|not capable/i.test(errorText(cause));
}

/**
 * One etcd client, recreated once when a call fails on a stale auth token (decision 11 of plan
 * 110): etcd3 renews a token it is told is invalid, but not one the auth store's revision outran.
 * Calls run in parallel, so only the first failure on a client replaces it; the others retry on
 * the replacement, and the old client closes once its last call has settled.
 */
export class EtcdClient {
  readonly #settings: ClientSettings;
  readonly #create: (settings: ClientSettings) => Etcd3;
  #etcd: Etcd3;
  readonly #inFlight = new Map<Etcd3, number>();
  readonly #retired = new Set<Etcd3>();
  #closed = false;
  readonly #pinned = new Map<string, EtcdClient>();
  readonly endpoints: readonly ClientEndpoint[];

  constructor(settings: ClientSettings, create: (settings: ClientSettings) => Etcd3 = createEtcd) {
    this.#settings = settings;
    this.#create = create;
    this.#etcd = create(settings);
    this.endpoints = settings.endpoints ?? [];
    for (const endpoint of this.endpoints) {
      const { endpoints: _endpoints, ...single } = settings;
      this.#pinned.set(
        endpoint.id,
        new EtcdClient({ ...single, address: endpoint.address, tls: endpoint.tls }, create),
      );
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async call<T>(work: (etcd: Etcd3) => Promise<T>): Promise<T> {
    if (this.#closed) throw new PluginError("connectionLost", "The connection to etcd is closed.");
    if (this.endpoints.length > 0) {
      const endpoint = this.endpoints[Math.floor(Math.random() * this.endpoints.length)]!;
      return this.pinned(endpoint.id).call(work);
    }
    const first = this.#etcd;
    try {
      return await this.#on(first, work);
    } catch (cause) {
      if (this.#closed || !STALE_AUTH.test(errorText(cause))) throw cause;
      if (this.#etcd === first) {
        this.#etcd = this.#create(this.#settings);
        this.#retire(first);
      }
      return this.#on(this.#etcd, work);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#etcd.close();
    for (const retired of this.#retired) retired.close();
    this.#retired.clear();
    for (const client of this.#pinned.values()) client.close();
  }

  /** A member-specific client; unknown or unadmitted endpoints can never be dialled. */
  pinned(endpointId: string): EtcdClient {
    if (this.#closed) throw new PluginError("connectionLost", "The connection to etcd is closed.");
    const client = this.#pinned.get(endpointId);
    if (client === undefined) throw new PluginError("statementFailed", "Choose a reachable configured etcd endpoint.");
    return client;
  }

  async #on<T>(etcd: Etcd3, work: (etcd: Etcd3) => Promise<T>): Promise<T> {
    this.#inFlight.set(etcd, (this.#inFlight.get(etcd) ?? 0) + 1);
    try {
      return await work(etcd);
    } catch (cause) {
      if (
        !this.#settings.connecting &&
        !STALE_AUTH.test(errorText(cause)) &&
        AMBIGUOUS_TRANSPORT.test(errorText(cause))
      )
        throw new EtcdAmbiguousError();
      throw cause;
    } finally {
      const left = (this.#inFlight.get(etcd) ?? 1) - 1;
      if (left > 0) this.#inFlight.set(etcd, left);
      else this.#inFlight.delete(etcd);
      if (left <= 0 && this.#retired.delete(etcd)) etcd.close();
    }
  }

  #retire(etcd: Etcd3): void {
    if ((this.#inFlight.get(etcd) ?? 0) === 0) etcd.close();
    else this.#retired.add(etcd);
  }
}
