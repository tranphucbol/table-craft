import {
  EXPORT_EVENT_TYPES,
  IMPORT_EVENT_TYPES,
  SCRIPT_EVENT_TYPES,
  type EngineCalls,
  type EngineError,
  type EngineErrorCode,
  type EngineEvent,
  type EngineMethod,
  type EngineResponse,
  type KeyConflictSnapshot,
  type ResultOf,
} from "@table-craft/desktop/engine/protocol.js";
import { ENGINE_PORT_WINDOW_MESSAGE, type EnginePortWindowMessage } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { rendererLog } from "@table-craft/desktop/renderer/log/log.js";

/** A request the engine answered with `engine.error`, or one that can no longer be answered. */
export class EngineRequestError extends Error {
  override readonly name = "EngineRequestError";
  readonly code: EngineErrorCode;
  readonly hint: string;
  /** The id the engine logged the request under (plan 017 decision 6); null when it never reached one. */
  readonly requestId: number | null;
  /** Where in the sent SQL the database said the statement went wrong (decision 082). */
  readonly position: number | undefined;
  readonly keyConflict: KeyConflictSnapshot | undefined;

  constructor(error: EngineError, requestId: number | null = null) {
    super(error.message);
    this.code = error.code;
    this.hint = error.hint;
    this.requestId = requestId;
    this.position = error.position;
    this.keyConflict = error.keyConflict;
  }
}

/** One counter for the window, so an id names one request across every datasource's log records. */
let nextRequestId = 1;

export interface EngineClient {
  call<M extends EngineMethod>(type: M, params: EngineCalls[M]["params"]): Promise<ResultOf<M>>;
  /** Rejects every pending and later call with `error` and closes the port: its engine is gone. */
  fail(error: EngineError): void;
  /** Events the engine pushes unasked, such as export progress (decision 040). */
  onEvent(listener: EngineEventListener): () => void;
}

export type EngineEventListener = (event: EngineEvent) => void;

const EVENT_TYPES: ReadonlySet<string> = new Set([...EXPORT_EVENT_TYPES, ...IMPORT_EVENT_TYPES, ...SCRIPT_EVENT_TYPES]);

function isEvent(message: EngineResponse | EngineEvent): message is EngineEvent {
  return message.id === null && EVENT_TYPES.has(message.type);
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export function clientFor(port: MessagePort): EngineClient {
  const pending = new Map<number, Pending>();
  let failure: EngineError | null = null;
  const listeners = new Set<EngineEventListener>();

  port.addEventListener("message", (event: MessageEvent<EngineResponse | EngineEvent>) => {
    const response = event.data;
    if (isEvent(response)) {
      for (const listener of listeners) listener(response);
      return;
    }
    if (response.id === null) {
      rendererLog("engine").error("engine rejected an unreadable request", {
        error: response.type === "engine.error" ? response.error.message : null,
      });
      return;
    }
    const waiting = pending.get(response.id);
    if (waiting === undefined) return;
    pending.delete(response.id);
    if (response.type === "engine.error") waiting.reject(new EngineRequestError(response.error, response.id));
    else waiting.resolve(response.result);
  });
  port.start();

  return {
    call(type, params) {
      if (failure !== null) return Promise.reject(new EngineRequestError(failure));
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ ...params, id, type });
      });
    },
    fail(error) {
      if (failure !== null) return;
      failure = error;
      for (const waiting of pending.values()) waiting.reject(new EngineRequestError(error));
      pending.clear();
      listeners.clear();
      port.close();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type EngineConnection =
  | { readonly status: "connected"; readonly client: EngineClient }
  | { readonly status: "needsSecrets"; readonly keys: readonly string[] }
  | { readonly status: "failed"; readonly error: EngineError };

function isPortMessage(data: unknown, datasourceId: string): data is EnginePortWindowMessage {
  const message = data as Partial<EnginePortWindowMessage> | null;
  return message?.kind === ENGINE_PORT_WINDOW_MESSAGE && message.datasourceId === datasourceId;
}

/**
 * Asks main for a port to the datasource's engine. The port can arrive before main's answer, so
 * the listener is in place first; preload relays it as a window message naming the datasource.
 */
export async function connectEngine(
  datasourceId: string,
  secrets?: Readonly<Record<string, string>>,
): Promise<EngineConnection> {
  let receive: ((event: MessageEvent) => void) | undefined;
  const port = new Promise<MessagePort>((resolve) => {
    receive = (event: MessageEvent) => {
      if (event.source !== window || !isPortMessage(event.data, datasourceId)) return;
      const received = event.ports[0];
      if (received !== undefined) resolve(received);
    };
    window.addEventListener("message", receive);
  });
  try {
    const answer = await bridge().connectEngine(datasourceId, secrets);
    if (!answer.ok) return { status: "failed", error: { code: "connectionFailed", ...answer.error } };
    const result = answer.value;
    if (result.status === "needsSecrets") return result;
    if (result.status === "failed") {
      return { status: "failed", error: { code: "connectionFailed", message: result.message, hint: result.hint } };
    }
    return { status: "connected", client: clientFor(await port) };
  } finally {
    if (receive !== undefined) window.removeEventListener("message", receive);
  }
}
