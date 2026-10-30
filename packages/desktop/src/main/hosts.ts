/**
 * One engine `utilityProcess` per datasource (decision 002). Main is not in the request path: it
 * boots the engine, hands one end of a channel to it and the other to the renderer, and stays out
 * of the way, so no request shape from `protocol.ts` is inspected here. Electron arrives through
 * `HostDependencies`, so this module runs under Vitest.
 */
import {
  ENGINE_BOOT_MESSAGE,
  ENGINE_HOST_KEY_ANSWER_MESSAGE,
  ENGINE_HOST_KEY_MESSAGE,
  ENGINE_LOG_MESSAGE,
  ENGINE_PROBED_MESSAGE,
  ENGINE_SHUTDOWN_MESSAGE,
  type DatasourceConfig,
  type EngineBoot,
  type EngineHostKeyAnswer,
  type EngineHostKeyRequest,
  type EngineLog,
  type EngineMode,
  type EngineProbed,
  type HostKeyOffer,
  type HostKeyVerdict,
  type PluginRoot,
  type ProbeResult,
} from "@table-craft/desktop/engine/protocol.js";
import type { Logger } from "@table-craft/desktop/log/record.js";

/** Test Connection gives up after this long and kills the probe engine (plan 004). */
export const PROBE_TIMEOUT_MS = 15_000;
/** How long a stopping engine may take to close its sessions before it is killed. */
export const SHUTDOWN_GRACE_MS = 3_000;
const MS_PER_SECOND = 1_000;
const SERVICE_NAME_PREFIX = "table-craft-engine-";
const PROBE_SERVICE_NAME_PREFIX = "table-craft-probe-";
const ENGINE_LOG_PROCESS = "engine:";
const PROBE_LOG_PROCESS = "probe:";

/** The slice of Electron's `UtilityProcess` the registry uses. */
export interface EngineProcess {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface HostDependencies<Target> {
  /** `logProcess` names the process in the log, `engine:<id>` or `probe:<id>` (plan 017). */
  fork(serviceName: string, logProcess: string): EngineProcess;
  /** Hands one end of a fresh channel to `host` and the other, tagged with the datasource, to `target`. */
  connectPort(host: EngineProcess, datasourceId: string, target: Target): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface HostRegistryOptions<Target> {
  /** Read at every engine boot, so a plugin installed meanwhile is in the next engine (decision 110). */
  readonly pluginRoots: () => readonly PluginRoot[];
  readonly dependencies: HostDependencies<Target>;
  /** `clean` is false when the engine died without being asked to, which the tree shows as failed. */
  readonly onExit: (datasourceId: string, code: number, clean: boolean) => void;
  readonly probeTimeoutMs?: number;
  readonly log?: HostLog;
  readonly now?: () => number;
  /** Rules on a host key an engine's SSH tunnel was offered (decision 071); absent, every key is rejected. */
  readonly hostKeys?: (offer: HostKeyOffer) => Promise<HostKeyVerdict>;
  readonly onStopping?: (datasourceId: string) => void;
}

/** How the registry reaches main's log (plan 017 decisions 7 and 9). */
export interface HostLog {
  readonly logger: Logger;
  /** A record an engine posted, with the process it came from. */
  forward(record: unknown, process: string): void;
  /** Called with every config before it leaves for an engine, so its secrets are redacted from then on. */
  protect(datasource: DatasourceConfig): void;
}

export interface HostRegistry<Target> {
  /** Starts the host for `datasource` if needed and gives `target` a fresh port to it. */
  open(datasource: DatasourceConfig, target: Target): void;
  isRunning(datasourceId: string): boolean;
  /** Asks the host to close its sessions and exit; resolves once it has. */
  stop(datasourceId: string): Promise<void>;
  /** Test Connection in a throwaway engine that never serves a port. Never rejects. */
  probe(datasource: DatasourceConfig): Promise<ProbeResult>;
  closeAll(): void;
}

interface RunningHost {
  readonly process: EngineProcess;
  readonly exited: Promise<void>;
  stopping: boolean;
}

function boot(mode: EngineMode, datasource: DatasourceConfig, pluginRoots: readonly PluginRoot[]): EngineBoot {
  return { kind: ENGINE_BOOT_MESSAGE, mode, datasource, pluginRoots };
}

function isProbed(message: unknown): message is EngineProbed {
  return (message as { kind?: unknown } | null)?.kind === ENGINE_PROBED_MESSAGE;
}

function isEngineLog(message: unknown): message is EngineLog {
  return (message as { kind?: unknown } | null)?.kind === ENGINE_LOG_MESSAGE;
}

function isHostKeyRequest(message: unknown): message is EngineHostKeyRequest {
  return (message as { kind?: unknown } | null)?.kind === ENGINE_HOST_KEY_MESSAGE;
}

/** While the user reads a fingerprint; a probe's timeout must not run meanwhile. */
interface Asking {
  asked(): void;
  answered(): void;
}

const REJECTED: HostKeyVerdict = { verdict: "rejected" };

export function createHostRegistry<Target>(options: HostRegistryOptions<Target>): HostRegistry<Target> {
  const { dependencies } = options;
  const hosts = new Map<string, RunningHost>();
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const log = options.log?.logger.child("engine");

  function answerHostKey(process: EngineProcess, request: EngineHostKeyRequest, asking?: Asking): void {
    asking?.asked();
    const ruling = options.hostKeys?.(request.offer) ?? Promise.resolve(REJECTED);
    void ruling
      .catch((cause: unknown) => {
        log?.warn("host key not checked", { error: cause instanceof Error ? cause.message : String(cause) });
        return REJECTED;
      })
      .then((verdict) => {
        asking?.answered();
        const answer: EngineHostKeyAnswer = {
          ...verdict,
          kind: ENGINE_HOST_KEY_ANSWER_MESSAGE,
          requestId: request.requestId,
        };
        process.postMessage(answer);
      });
  }

  function fork(serviceName: string, logProcess: string, asking?: Asking): EngineProcess {
    const process = dependencies.fork(serviceName, logProcess);
    process.on("message", (message) => {
      if (isEngineLog(message)) options.log?.forward(message.record, logProcess);
      else if (isHostKeyRequest(message)) answerHostKey(process, message, asking);
    });
    return process;
  }

  function spawn(datasource: DatasourceConfig): RunningHost {
    const startedAt = now();
    const fields = { datasourceId: datasource.id, pluginId: datasource.pluginId };
    const process = fork(`${SERVICE_NAME_PREFIX}${datasource.id}`, `${ENGINE_LOG_PROCESS}${datasource.id}`);
    log?.info("engine host started", fields);
    let host: RunningHost | null = null;
    const exited = new Promise<void>((resolve) => {
      process.once("exit", (code) => {
        if (hosts.get(datasource.id) === host) hosts.delete(datasource.id);
        const clean = host?.stopping === true || code === 0;
        const exit = { ...fields, code, clean, uptimeMs: now() - startedAt };
        if (clean) log?.info("engine host exited", exit);
        else log?.warn("engine host exited unexpectedly", exit);
        options.onExit(datasource.id, code, clean);
        resolve();
      });
    });
    host = { process, exited, stopping: false };
    process.postMessage(boot("serve", datasource, options.pluginRoots()));
    hosts.set(datasource.id, host);
    return host;
  }

  function stop(datasourceId: string): Promise<void> {
    const host = hosts.get(datasourceId);
    if (host === undefined) return Promise.resolve();
    hosts.delete(datasourceId);
    options.onStopping?.(datasourceId);
    host.stopping = true;
    host.process.postMessage({ kind: ENGINE_SHUTDOWN_MESSAGE });
    const timer = dependencies.setTimeout(() => host.process.kill(), SHUTDOWN_GRACE_MS);
    return host.exited.finally(() => dependencies.clearTimeout(timer));
  }

  function probe(datasource: DatasourceConfig): Promise<ProbeResult> {
    options.log?.protect(datasource);
    const startedAt = now();
    const fields = { datasourceId: datasource.id, pluginId: datasource.pluginId };
    let timer: unknown = null;
    let arm: () => void = () => undefined;
    const asking: Asking = {
      asked: () => dependencies.clearTimeout(timer),
      answered: () => arm(),
    };
    const process = fork(
      `${PROBE_SERVICE_NAME_PREFIX}${datasource.id}`,
      `${PROBE_LOG_PROCESS}${datasource.id}`,
      asking,
    );
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: ProbeResult): void => {
        if (settled) return;
        settled = true;
        dependencies.clearTimeout(timer);
        const elapsedMs = now() - startedAt;
        if (result.ok) log?.info("test connection succeeded", { ...fields, elapsedMs });
        else
          log?.warn("test connection failed", {
            ...fields,
            elapsedMs,
            code: result.error.code,
            error: result.error.message,
          });
        resolve(result);
      };
      arm = () => {
        if (settled) return;
        timer = dependencies.setTimeout(() => {
          settle({
            ok: false,
            error: {
              code: "timedOut",
              message: `The database did not answer within ${String(probeTimeoutMs / MS_PER_SECOND)} s.`,
              hint: "Check the host and port, and that nothing between here and the server drops the connection.",
            },
          });
          process.kill();
        }, probeTimeoutMs);
      };
      arm();
      process.on("message", (message) => {
        if (isProbed(message)) settle(message.result);
      });
      process.once("exit", (code) => {
        settle({
          ok: false,
          error: {
            code: "internal",
            message: `The test connection's engine exited with code ${String(code)} before it answered.`,
            hint: "This is a TableCraft bug; restart the app and report it.",
          },
        });
      });
      process.postMessage(boot("probe", datasource, options.pluginRoots()));
    });
  }

  return {
    open(datasource, target) {
      options.log?.protect(datasource);
      const host = hosts.get(datasource.id) ?? spawn(datasource);
      dependencies.connectPort(host.process, datasource.id, target);
    },
    isRunning: (datasourceId) => hosts.has(datasourceId),
    stop,
    probe,
    closeAll() {
      for (const datasourceId of hosts.keys()) options.onStopping?.(datasourceId);
      for (const host of hosts.values()) {
        host.stopping = true;
        host.process.kill();
      }
      hosts.clear();
    },
  };
}
