/** JSON-RPC 2.0, as MCP frames it: https://www.jsonrpc.org/specification */
export const JSONRPC_VERSION = "2.0";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;
export type JsonObject = Readonly<Record<string, unknown>>;

export type Incoming =
  | { readonly kind: "request"; readonly id: JsonRpcId; readonly method: string; readonly params: JsonObject }
  | { readonly kind: "notification"; readonly method: string; readonly params: JsonObject }
  /** A client's answer to a server request; this server sends none, so it is acknowledged and dropped. */
  | { readonly kind: "response" };

export interface JsonRpcError {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: { readonly code: number; readonly message: string };
}

export interface JsonRpcResult {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: unknown;
}

/** Thrown by a method handler; the server answers it as a JSON-RPC error with this code. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResult {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

/**
 * One message from a POST body. Batches are refused: the 2025-06-18 revision of MCP removed them.
 * Throws `RpcError` with the code to answer.
 */
export function parseMessage(text: string): Incoming {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RpcError(PARSE_ERROR, "The body is not JSON.");
  }
  if (Array.isArray(value)) throw new RpcError(INVALID_REQUEST, "Batches are not supported; send one message.");
  if (!isObject(value) || value.jsonrpc !== JSONRPC_VERSION) {
    throw new RpcError(INVALID_REQUEST, 'Expected a JSON-RPC 2.0 object with "jsonrpc": "2.0".');
  }
  if (!("method" in value)) {
    if ("result" in value || "error" in value) return { kind: "response" };
    throw new RpcError(INVALID_REQUEST, "The message has no method.");
  }
  const { method, params = {} } = value;
  if (typeof method !== "string") throw new RpcError(INVALID_REQUEST, "The method must be a string.");
  if (!isObject(params)) throw new RpcError(INVALID_PARAMS, "params must be an object.");
  if (!("id" in value)) return { kind: "notification", method, params };
  if (!isId(value.id)) throw new RpcError(INVALID_REQUEST, "The id must be a string or an integer.");
  return { kind: "request", id: value.id, method, params };
}

/** The id to answer a broken message with, when its body still names one. */
export function idOf(text: string): JsonRpcId | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) && isId(value.id) ? value.id : null;
  } catch {
    return null;
  }
}
