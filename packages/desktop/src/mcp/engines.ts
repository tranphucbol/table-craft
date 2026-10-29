import type { Capability, EngineCalls, EngineResponse, OpenedSession } from "@table-craft/desktop/engine/protocol.js";

/** The MCP host's end of an engine `MessagePort`, narrowed so tests can drive an engine in-process. */
export interface EnginePort {
  postMessage(message: unknown): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type EngineMethod = keyof EngineCalls;
export type EngineCall = <M extends EngineMethod>(
  type: M,
  params: EngineCalls[M]["params"],
) => Promise<EngineCalls[M]["result"]>;

/** An `engine.error` answer, or the engine going away mid-call. */
export class EngineCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null,
  ) {
    super(message);
    this.name = "EngineCallError";
  }
}

const ENGINE_GONE = new EngineCallError(
  "engineExited",
  "The datasource's engine stopped.",
  "Call the tool again; TableCraft reconnects.",
);

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

function isResponse(data: unknown): data is EngineResponse & { readonly id: number } {
  return typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "number";
}

/** Id-correlated calls over one port, as the renderer's client makes them; events are ignored. */
export function engineClient(port: EnginePort): { readonly call: EngineCall; readonly closed: () => boolean } {
  const pending = new Map<number, Pending>();
  let next = 0;
  let closed = false;
  port.onMessage((data) => {
    if (!isResponse(data)) return;
    const waiting = pending.get(data.id);
    if (waiting === undefined) return;
    pending.delete(data.id);
    if (data.type === "engine.error") {
      waiting.reject(new EngineCallError(data.error.code, data.error.message, data.error.hint));
    } else {
      waiting.resolve(data.result);
    }
  });
  port.onClose(() => {
    closed = true;
    for (const waiting of pending.values()) waiting.reject(ENGINE_GONE);
    pending.clear();
  });
  const call: EngineCall = (type, params) => {
    if (closed) return Promise.reject(ENGINE_GONE);
    next += 1;
    const id = next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      port.postMessage({ ...params, id, type });
    });
  };
  return { call, closed: () => closed };
}

export type SessionMode = "read" | "write";

/** One datasource's engine as agents use it: their own sessions, one statement at a time on each. */
export interface AgentEngine {
  readonly call: EngineCall;
  capabilities(): Promise<readonly Capability[]>;
  /** Runs `use` with the agents' session in `mode`, after whatever runs on it already. */
  withSession<T>(mode: SessionMode, use: (sessionId: string) => Promise<T>): Promise<T>;
  /** Cancels what runs on the `mode` session now, without waiting in its queue. */
  cancel(mode: SessionMode): Promise<void>;
}

export interface AgentEngines {
  engine(datasourceId: string): Promise<AgentEngine>;
  /** Closes the datasource's port, so its sessions and results go with it. */
  drop(datasourceId: string): void;
  closeAll(): void;
}

function agentEngine(port: EnginePort): AgentEngine {
  const { call } = engineClient(port);
  const sessions = new Map<SessionMode, Promise<OpenedSession>>();
  const queues = new Map<SessionMode, Promise<unknown>>();

  function opened(mode: SessionMode): Promise<OpenedSession> {
    const existing = sessions.get(mode);
    if (existing !== undefined) return existing;
    const opening = call("session.open", { readOnly: mode === "read" });
    sessions.set(mode, opening);
    opening.catch(() => sessions.delete(mode));
    return opening;
  }

  return {
    call,
    capabilities: async () => (await opened("read")).capabilities,
    withSession(mode, use) {
      const before = queues.get(mode) ?? Promise.resolve();
      const run = before.catch(() => undefined).then(async () => use((await opened(mode)).sessionId));
      queues.set(mode, run);
      return run;
    },
    async cancel(mode) {
      const session = sessions.get(mode);
      if (session === undefined) return;
      await call("statement.cancel", { sessionId: (await session).sessionId });
    },
  };
}

export function createAgentEngines(connect: (datasourceId: string) => Promise<EnginePort>): AgentEngines {
  const engines = new Map<string, { readonly port: Promise<EnginePort>; readonly engine: Promise<AgentEngine> }>();

  return {
    engine(datasourceId) {
      const existing = engines.get(datasourceId);
      if (existing !== undefined) return existing.engine;
      const port = connect(datasourceId);
      const engine = port.then((connected) => {
        connected.onClose(() => {
          if (engines.get(datasourceId)?.port === port) engines.delete(datasourceId);
        });
        return agentEngine(connected);
      });
      engines.set(datasourceId, { port, engine });
      engine.catch(() => engines.delete(datasourceId));
      return engine;
    },
    drop(datasourceId) {
      const existing = engines.get(datasourceId);
      engines.delete(datasourceId);
      void existing?.port.then((port) => port.close()).catch(() => undefined);
    },
    closeAll() {
      for (const id of [...engines.keys()]) this.drop(id);
    },
  };
}
