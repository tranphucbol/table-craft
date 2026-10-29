import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HTTP_NOT_FOUND, HTTP_OK, type McpServer } from "@table-craft/desktop/mcp/server.js";
import { MCP_HOST, MCP_PATH } from "@table-craft/desktop/settings/mcp.js";

/** A JSON-RPC message is small; anything bigger is a mistake or an attack. */
export const MAX_BODY_BYTES = 1024 * 1024;
export const SESSION_HEADER = "mcp-session-id";
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];
const BEARER = /^Bearer\s+(\S+)$/i;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_PAYLOAD_TOO_LARGE = 413;

export interface HttpListener {
  readonly port: number;
  close(): Promise<void>;
}

export interface HttpOptions {
  readonly port: number;
  readonly token: string;
  readonly server: McpServer;
  readonly onError?: (cause: unknown) => void;
}

/** Thrown when the port is taken or not ours to bind; the settings page says which. */
export class ListenError extends Error {
  constructor(
    readonly port: number,
    readonly code: string,
  ) {
    super(
      code === "EADDRINUSE"
        ? `Port ${String(port)} is in use. Choose another port in Settings › MCP Server.`
        : `TableCraft could not listen on port ${String(port)} (${code}). Choose another port in Settings › MCP Server.`,
    );
    this.name = "ListenError";
  }
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function authorized(header: string | undefined, token: string): boolean {
  const presented = BEARER.exec(header ?? "")?.[1];
  return presented !== undefined && timingSafeEqual(digest(presented), digest(token));
}

/** DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends its own Host and Origin. */
function sameMachine(request: IncomingMessage, port: number): boolean {
  const hosts = LOOPBACK_NAMES.map((name) => `${name}:${String(port)}`);
  if (!hosts.includes(request.headers.host ?? "")) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_NAMES.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    response.writeHead(status, headers).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sessionOf(request: IncomingMessage): string | null {
  const header = request.headers[SESSION_HEADER];
  return typeof header === "string" && header.length > 0 ? header : null;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  options: HttpOptions,
): Promise<void> {
  const path = new URL(request.url ?? "/", `http://${MCP_HOST}`).pathname;
  if (path !== MCP_PATH) return send(response, HTTP_NOT_FOUND);
  if (!sameMachine(request, port)) return send(response, HTTP_FORBIDDEN);
  if (!authorized(request.headers.authorization, options.token)) {
    return send(response, HTTP_UNAUTHORIZED, undefined, { "www-authenticate": "Bearer" });
  }
  if (request.method === "DELETE") {
    const sessionId = sessionOf(request);
    return send(response, sessionId !== null && options.server.end(sessionId) ? HTTP_OK : HTTP_NOT_FOUND);
  }
  if (request.method !== "POST") return send(response, HTTP_METHOD_NOT_ALLOWED, undefined, { allow: "POST, DELETE" });
  const body = await readBody(request);
  if (body === null) return send(response, HTTP_PAYLOAD_TOO_LARGE);
  const reply = await options.server.handle(sessionOf(request), body);
  send(response, reply.status, reply.body, reply.sessionId === undefined ? {} : { [SESSION_HEADER]: reply.sessionId });
}

/** Listens on the loopback address only; port 0 picks a free one, for tests. */
export function listen(options: HttpOptions): Promise<HttpListener> {
  return new Promise((resolve, reject) => {
    let port = options.port;
    const http = createServer((request, response) => {
      route(request, response, port, options).catch((cause: unknown) => {
        options.onError?.(cause);
        if (!response.headersSent) send(response, 500);
      });
    });
    http.once("error", (cause: NodeJS.ErrnoException) =>
      reject(new ListenError(options.port, cause.code ?? "unknown")),
    );
    http.listen(options.port, MCP_HOST, () => {
      port = (http.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });
}
