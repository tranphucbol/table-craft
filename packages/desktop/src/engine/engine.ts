import {
  TunnelError,
  createConnector,
  loadedPlugin,
  type Connector,
  type HostKeyVerifier,
  type PluginLoadResult,
} from "@table-craft/core";
import { MS_PER_SECOND, connectDatasource } from "@table-craft/desktop/engine/connect.js";
import { createConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { createEngineContext } from "@table-craft/desktop/engine/context.js";
import { BUG_HINT, toEngineError } from "@table-craft/desktop/engine/failures.js";
import type {
  DatasourceConfig,
  EngineEvent,
  EngineMethod,
  EngineResponse,
  ProbeResult,
  RequestOf,
  ResultOf,
} from "@table-craft/desktop/engine/protocol.js";
import { logResponse } from "@table-craft/desktop/engine/requestLog.js";
import { engineRequestSchema, readRequestId } from "@table-craft/desktop/engine/requests.js";
import { routesOf } from "@table-craft/desktop/engine/routes/index.js";
import type { Logger } from "@table-craft/desktop/log/record.js";
import type { EngineOperationFiles } from "@table-craft/desktop/engine/keyOperations/files.js";
import { applyAccessSecret } from "@table-craft/desktop/engine/keyOperations/index.js";
import { KeyOperationScope, invalidOperation } from "@table-craft/desktop/engine/keyOperations/scope.js";

export interface EngineOptions {
  readonly datasource: DatasourceConfig;
  readonly plugins: readonly PluginLoadResult[];
  /** Where request records go (plan 017); silent when absent, as in most tests. */
  readonly log?: Logger;
  /** Asks main whether to trust an SSH host key (decision 071); absent, every key is refused unknown. */
  readonly verifyHostKey?: HostKeyVerifier;
  readonly operationFiles?: EngineOperationFiles;
}

/** One renderer port's view of the engine. Its sessions and results die with it. */
export interface EngineConnection {
  applyAccessSecret(change: unknown, sessionId?: string): Promise<void>;
  handle(message: unknown): Promise<EngineResponse>;
  close(): Promise<void>;
}

export interface Engine {
  /** Trusted private control only; never expose through the renderer MessagePort. */
  applyAccessSecret(change: unknown): Promise<void>;
  /** `emit` receives every export and import event, whichever connection started the task (decisions 040, 046). */
  connect(emit?: (event: EngineEvent) => void, files?: EngineOperationFiles): EngineConnection;
  /** Resolves once no export or import runs, so a reloading window does not cut one short. */
  tasksSettled(): Promise<void>;
  /** Closes what the engine holds for every connection: export and import tasks and the introspection session. */
  close(): Promise<void>;
}

const refuseUnknownHostKey: HostKeyVerifier = (offer) =>
  Promise.reject(
    new TunnelError(
      "sshHostKeyUnknown",
      `The SSH server ${offer.host}:${String(offer.port)} presented an unknown ${offer.algorithm} key ${offer.fingerprint}.`,
      "Connect from a TableCraft window, which asks whether to trust the key.",
    ),
  );

/** The data source's connector: one SSH tunnel shared by every session, or none (decision 070). */
export function datasourceConnector(options: EngineOptions): Connector {
  const { datasource } = options;
  const { keepAliveSeconds } = datasource;
  return createConnector({
    plugins: options.plugins,
    pluginId: datasource.pluginId,
    config: datasource.config,
    ssh: datasource.ssh ?? null,
    verifyHostKey: options.verifyHostKey ?? refuseUnknownHostKey,
    ...(keepAliveSeconds > 0 ? { keepAliveMs: keepAliveSeconds * MS_PER_SECOND } : {}),
  });
}

/**
 * Test Connection (plan 004): connect once, read what the server reports, close. Never rejects;
 * a failure comes back as the error the console would have shown, and the SSH hop, when the
 * tunnel opened, comes back either way.
 */
export async function probeDatasource(options: EngineOptions, now: () => number = Date.now): Promise<ProbeResult> {
  const connector = datasourceConnector(options);
  const started = now();
  try {
    const session = await connectDatasource(options, connector);
    const elapsedMs = now() - started;
    await session.close().catch(() => undefined);
    const { manifest } = loadedPlugin(options.plugins, options.datasource.pluginId);
    const hop = connector.hop;
    return {
      ok: true,
      pluginName: manifest.name,
      serverVersion: session.serverVersion,
      serverBrand: session.serverBrand ?? null,
      elapsedMs,
      ...(hop === null ? {} : { ssh: hop }),
      ...(session.tls === undefined ? {} : { tls: session.tls === null ? null : { ...session.tls } }),
      ...(session.serverTimeout === undefined
        ? {}
        : { serverTimeout: session.serverTimeout === null ? null : { ...session.serverTimeout } }),
      cancelReach: session.cancelReach === undefined ? null : { ...session.cancelReach },
    };
  } catch (cause) {
    const hop = connector.hop;
    return { ok: false, error: toEngineError(cause), ...(hop === null ? {} : { ssh: hop }) };
  } finally {
    await connector.close();
  }
}

export function createEngine(options: EngineOptions, now: () => number = Date.now): Engine {
  const context = createEngineContext(options, datasourceConnector(options), now);
  const { log, logContext, tasks, imports, scripts, connector } = context;
  const connections = new Set<ReturnType<typeof createConnectionContext>>();
  const credentials = new KeyOperationScope(context);
  let closed = false;

  function connect(
    emit: (event: EngineEvent) => void = () => undefined,
    files?: EngineOperationFiles,
  ): EngineConnection {
    if (closed) throw invalidOperation("This engine has closed.");
    const connection = createConnectionContext(
      files === undefined ? context : { ...context, options: { ...options, operationFiles: files } },
      emit,
    );
    connections.add(connection);
    const routes = routesOf(connection);

    async function route<M extends EngineMethod>(request: RequestOf<M>): Promise<EngineResponse> {
      const run = routes[request.type] as (request: RequestOf<M>) => Promise<ResultOf<M>>;
      const result = await run(request);
      return { id: request.id, type: request.type, result } as EngineResponse;
    }

    return {
      applyAccessSecret: async (change, sessionId) => {
        if (sessionId !== undefined) connection.sessionFor(sessionId);
        await applyAccessSecret(connection.keyOperations.scope, change);
      },
      async handle(message) {
        if (closed || !connections.has(connection))
          return {
            id: readRequestId(message),
            type: "engine.error",
            error: {
              code: "connectionLost",
              message: "This engine connection has closed.",
              hint: "Reconnect to the datasource.",
            },
          };
        const parsed = engineRequestSchema.safeParse(message);
        if (!parsed.success) {
          return {
            id: readRequestId(message),
            type: "engine.error",
            error: {
              code: "invalidRequest",
              message: `The engine could not read the request: ${parsed.error.message}`,
              hint: BUG_HINT,
            },
          };
        }
        const request = parsed.data;
        const started = now();
        try {
          const response = await route(request);
          if (log !== null)
            logResponse(request, { result: (response as { result?: unknown }).result }, logContext(request, started));
          return response;
        } catch (cause) {
          const error = toEngineError(cause);
          if (log !== null) logResponse(request, { error, cause }, logContext(request, started));
          return { id: request.id, type: "engine.error", error };
        }
      },
      close: async () => {
        connections.delete(connection);
        await connection.close();
      },
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...connections].map((connection) => connection.close()));
    connections.clear();
    await credentials.close();
    await Promise.all([tasks.close(), imports.close(), scripts.close()]);
    await context.closeIntrospection();
    await connector.close();
  }

  return {
    applyAccessSecret: (change) => applyAccessSecret(credentials, change),
    connect,
    tasksSettled: async () => {
      await Promise.all([
        tasks.settled(),
        imports.settled(),
        scripts.settled(),
        ...[...connections].map((connection) => connection.keyOperations.tasks.settled()),
      ]);
    },
    close,
  };
}
