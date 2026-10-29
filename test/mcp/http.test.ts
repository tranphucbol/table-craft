import { request } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import { createLogger } from "@table-craft/desktop/log/record.js";
import { createMcpHost, type McpHost } from "@table-craft/desktop/mcp/host.js";
import { listen, ListenError, MAX_BODY_BYTES, SESSION_HEADER } from "@table-craft/desktop/mcp/http.js";
import {
  MCP_BOOT_MESSAGE,
  MCP_CONFIG_MESSAGE,
  MCP_CONTROL_MESSAGE,
  MCP_ENGINE_ANSWER_MESSAGE,
  MCP_ENGINE_PORT_MESSAGE,
  MCP_ENGINE_REQUEST_MESSAGE,
  MCP_HISTORY_MESSAGE,
  MCP_STATUS_MESSAGE,
  type AgentHistoryEntry,
  type McpToMain,
} from "@table-craft/desktop/mcp/messages.js";
import type { McpServer } from "@table-craft/desktop/mcp/server.js";
import type { McpKnownClient, McpStatus } from "@table-craft/desktop/settings/mcp.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { inProcessPort } from "../support/mcpHarness.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const TOKEN = "tc_test-token";
const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const SILENT = createLogger({ process: "mcp", scope: "test", sink: () => undefined });
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1" } },
};

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

function send(
  port: number,
  options: { method?: string; body?: string; headers?: Record<string, string>; path?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? "/mcp",
        method: options.method ?? "POST",
        headers: {
          host: `127.0.0.1:${String(port)}`,
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text === "" ? null : JSON.parse(text),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

function rpc(port: number, message: unknown, sessionId?: string): Promise<Reply> {
  return send(port, {
    body: JSON.stringify(message),
    headers: sessionId === undefined ? {} : { [SESSION_HEADER]: sessionId },
  });
}

let host: McpHost | null = null;

afterEach(async () => {
  await host?.close();
  host = null;
});

const KNOWN_CLIENTS: readonly McpKnownClient[] = [{ name: "claude-code", allowed: true }];
const COUNT_ORDERS = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "run_query", arguments: { datasource: "shop", sql: "SELECT count(*) AS n FROM orders" } },
};

async function bootedHost(clients = KNOWN_CLIENTS): Promise<{
  readonly port: number;
  readonly statuses: McpStatus[];
  readonly history: AgentHistoryEntry[];
}> {
  const path = seededSqliteFile();
  const statuses: McpStatus[] = [];
  const history: AgentHistoryEntry[] = [];
  let sessions = 0;
  const started = createMcpHost({
    log: SILENT,
    newSessionId: () => `session-${String((sessions += 1))}`,
    send: (message: McpToMain) => {
      if (message.kind === MCP_STATUS_MESSAGE) statuses.push(message.status);
      if (message.kind === MCP_HISTORY_MESSAGE) history.push(message.entry);
      if (message.kind === MCP_ENGINE_REQUEST_MESSAGE) {
        const engine = createEngine({
          datasource: {
            id: message.datasourceId,
            pluginId: "sqlite",
            config: { path },
            readOnly: false,
            keepAliveSeconds: 0,
          },
          plugins: [LOADED_SQLITE],
        });
        queueMicrotask(() => {
          started.handle(
            { kind: MCP_ENGINE_PORT_MESSAGE, requestId: message.requestId },
            inProcessPort(engine.connect()),
          );
          started.handle({
            kind: MCP_ENGINE_ANSWER_MESSAGE,
            requestId: message.requestId,
            answer: { status: "connected" },
          });
        });
      }
    },
  });
  host = started;
  started.handle({
    kind: MCP_BOOT_MESSAGE,
    port: 0,
    token: TOKEN,
    serverVersion: "1.2.3",
    rowCap: 10,
    windows: true,
    clients,
    datasources: [{ id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "read" }],
  });
  await started.ready();
  const running = statuses.at(-1);
  if (running?.state !== "running") throw new Error(`MCP host did not start: ${running?.message ?? "no status"}`);
  return { port: running.port, statuses, history };
}

async function initialized(port: number): Promise<string> {
  const reply = await rpc(port, INITIALIZE);
  const sessionId = reply.headers[SESSION_HEADER];
  if (typeof sessionId !== "string") throw new Error("initialize returned no session id");
  await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return sessionId;
}

describe("MCP over HTTP", () => {
  it("givenRunningHost_whenClientInitializes_thenSessionIdAndServerInfoComeBack", async () => {
    const { port, statuses } = await bootedHost();

    const reply = await rpc(port, INITIALIZE);

    expect(reply.status).toBe(200);
    expect(reply.headers[SESSION_HEADER]).toBe("session-1");
    expect(reply.body).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "TableCraft", version: "1.2.3" } },
    });
    expect(statuses.at(-1)?.clients).toMatchObject([{ id: "session-1", name: "claude-code", version: "2.1" }]);
  });

  it("givenSession_whenToolsListedAndCalled_thenRowsComeBackAndHistoryIsRecorded", async () => {
    const { port, statuses, history } = await bootedHost();
    const sessionId = await initialized(port);

    const listed = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
    const called = await rpc(
      port,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "run_query", arguments: { datasource: "shop", sql: "SELECT count(*) AS n FROM orders" } },
      },
      sessionId,
    );

    expect((listed.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(15);
    expect(called.body).toMatchObject({ id: 3, result: { structuredContent: { rows: [{ n: 3 }] } } });
    expect(history).toMatchObject([{ datasourceId: "shop", outcome: "success", rowCount: 1 }]);
    expect(statuses.at(-1)?.clients[0]?.lastCall).toMatchObject({
      tool: "run_query",
      datasourceId: "shop",
      outcome: "ok",
    });
  });

  it("givenUnknownClient_whenUserAllowsIt_thenWaitingCallRunsAndActivityRecorded", async () => {
    const { port, statuses } = await bootedHost([]);
    const sessionId = await initialized(port);

    const called = rpc(port, COUNT_ORDERS, sessionId);
    await expect.poll(() => statuses.at(-1)?.pendingClients.map((client) => client.name)).toEqual(["claude-code"]);
    host?.handle({ kind: MCP_CONFIG_MESSAGE, rowCap: 10, clients: KNOWN_CLIENTS });

    expect((await called).body).toMatchObject({ id: 3, result: { structuredContent: { rows: [{ n: 3 }] } } });
    expect(statuses.at(-1)?.pendingClients).toEqual([]);
    expect(statuses.at(-1)?.activity).toMatchObject([
      { tool: "run_query", clientName: "claude-code", outcome: "ok", target: "SELECT count(*) AS n FROM orders" },
    ]);
  });

  it("givenBlockedClient_whenToolCalled_thenRefusedWithoutRunning", async () => {
    const { port, history } = await bootedHost([{ name: "claude-code", allowed: false }]);
    const sessionId = await initialized(port);

    const called = await rpc(port, COUNT_ORDERS, sessionId);

    expect(called.body).toMatchObject({ id: 3, result: { isError: true } });
    expect(history).toEqual([]);
  });

  it("givenSession_whenResourceRead_thenTableDescribed", async () => {
    const { port } = await bootedHost();
    const sessionId = await initialized(port);

    const listed = await rpc(port, { jsonrpc: "2.0", id: 2, method: "resources/list" }, sessionId);
    const read = await rpc(
      port,
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "tablecraft://shop/main/orders" } },
      sessionId,
    );

    expect(listed.body).toMatchObject({ result: { resources: [{ uri: "tablecraft://shop" }] } });
    expect(read.body).toMatchObject({ result: { contents: [{ uri: "tablecraft://shop/main/orders" }] } });
  });

  it("givenPausedAgents_whenToolCalled_thenRefusedWithoutRunning", async () => {
    const { port, history } = await bootedHost();
    const sessionId = await initialized(port);
    host?.handle({ kind: MCP_CONTROL_MESSAGE, action: "pause", paused: true });

    const called = await rpc(
      port,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_datasources", arguments: {} } },
      sessionId,
    );

    expect(called.body).toMatchObject({ result: { isError: true } });
    expect(history).toEqual([]);
  });

  it("givenNoOrUnknownSession_whenRequesting_thenBadRequestOrNotFound", async () => {
    const { port } = await bootedHost();

    const missing = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const unknown = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "nope");

    expect(missing.status).toBe(400);
    expect(unknown.status).toBe(404);
  });

  it("givenWrongTokenForeignHostOrOrigin_whenRequesting_thenRefused", async () => {
    const { port } = await bootedHost();
    const body = JSON.stringify(INITIALIZE);

    const noToken = await send(port, { body, headers: { authorization: "Bearer wrong" } });
    const rebound = await send(port, { body, headers: { host: `evil.example:${String(port)}` } });
    const foreignOrigin = await send(port, { body, headers: { origin: "https://evil.example" } });
    const localOrigin = await send(port, { body, headers: { origin: `http://localhost:${String(port)}` } });

    expect(noToken.status).toBe(401);
    expect(noToken.headers["www-authenticate"]).toBe("Bearer");
    expect(rebound.status).toBe(403);
    expect(foreignOrigin.status).toBe(403);
    expect(localOrigin.status).toBe(200);
  });

  it("givenOtherMethodsPathsAndHugeBodies_whenRequesting_thenRefusedByStatus", async () => {
    const { port } = await bootedHost();

    const get = await send(port, { method: "GET" });
    const elsewhere = await send(port, { path: "/other" });
    const huge = await send(port, { body: "x".repeat(MAX_BODY_BYTES + 1) }).catch(() => ({ status: 413 }));

    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST, DELETE");
    expect(elsewhere.status).toBe(404);
    expect(huge.status).toBe(413);
  });

  it("givenSession_whenDeletedOrDisconnected_thenItEnds", async () => {
    const { port, statuses } = await bootedHost();
    const first = await initialized(port);
    const second = await initialized(port);

    const deleted = await send(port, { method: "DELETE", headers: { [SESSION_HEADER]: first } });
    host?.handle({ kind: MCP_CONTROL_MESSAGE, action: "disconnect", clientId: second });
    const after = await rpc(port, { jsonrpc: "2.0", id: 9, method: "ping" }, second);

    expect(deleted.status).toBe(200);
    expect(after.status).toBe(404);
    expect(statuses.at(-1)?.clients).toEqual([]);
  });

  it("givenPortTaken_whenListening_thenListenErrorNamesThePort", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;

    try {
      await expect(listen({ port, token: TOKEN, server: {} as McpServer })).rejects.toEqual(
        new ListenError(port, "EADDRINUSE"),
      );
    } finally {
      blocker.close();
    }
  });
});
