import { connect as connectTcp, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginError, z, type DatasourcePlugin } from "@table-craft/plugin-api";
import type { HostKeyOffer, HostKeyVerifier, PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine, probeDatasource, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type {
  DatasourceConfig,
  EngineResponse,
  ExecutedStatement,
  OpenedSession,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { fakeManifest } from "../support/manifests.js";
import { SSH_PASSWORD, SSH_USER, startEchoServer, startSshServer, type TestSshServer } from "../support/sshServer.js";

const PLUGIN_ID = "networked";
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const HELLO = "hello";
const LOOPBACK = "127.0.0.1";

interface Reached {
  readonly host: string;
  readonly port: number;
  readonly serverName: string | undefined;
}

/** Proves the route end to end: the database here is an echo server that must answer before SQLite opens. */
function reach(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, host);
    const refuse = (why: string) => reject(new PluginError("connectionFailed", why));
    socket.once("error", (error) => refuse(error.message));
    socket.once("close", () => refuse("the server closed the connection"));
    socket.once("data", () => {
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      socket.on("error", () => undefined);
      resolve(socket);
    });
    socket.write(HELLO);
  });
}

/** SQLite dressed as a server plugin whose `host` and `port` must reach a live TCP server. */
function networkedPlugin(reached: Reached[]): PluginLoadResult {
  const connectionSchema = z.strictObject({ host: z.string(), port: z.number(), path: z.string() });
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: PLUGIN_ID,
    capabilities: ["sql"],
    connectionSchema,
    connect: async (config, options) => {
      const { host, port, path } = connectionSchema.parse(config);
      const socket = await reach(host, port);
      reached.push({ host, port, serverName: options.serverName });
      const session = await sqlite.connect({ path }, options);
      return {
        execute: (sql, params) => session.execute(sql, params),
        serverVersion: session.serverVersion,
        close: async () => {
          socket.destroy();
          await session.close();
        },
      };
    },
  };
  const manifest = fakeManifest({
    id: PLUGIN_ID,
    connection: {
      fields: [
        { key: "host", label: "Host", kind: "text" },
        { key: "port", label: "Port", kind: "number" },
        { key: "path", label: "Path", kind: "text" },
      ],
      network: { host: "host", port: "port" },
    },
  });
  return { status: "loaded", directory: "plugins/networked", manifest, plugin };
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

async function open(connection: EngineConnection): Promise<string> {
  return resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
}

function execute(connection: EngineConnection, sessionId: string, sql: string): Promise<EngineResponse> {
  return connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql });
}

function closeSession(connection: EngineConnection, sessionId: string): Promise<EngineResponse> {
  return connection.handle({ id: 3, type: "session.close", sessionId });
}

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const poll = (): void => {
      if (condition()) resolve();
      else setTimeout(poll, 5);
    };
    poll();
  });
}

let ssh: TestSshServer;
let database: Awaited<ReturnType<typeof startEchoServer>>;
let offers: HostKeyOffer[];
let reached: Reached[];
const trustAll: HostKeyVerifier = (offer) => {
  offers.push(offer);
  return Promise.resolve();
};

function datasource(password = SSH_PASSWORD): DatasourceConfig {
  return {
    id: "n",
    pluginId: PLUGIN_ID,
    config: { host: LOOPBACK, port: database.port, path: ":memory:" },
    readOnly: false,
    keepAliveSeconds: 0,
    ssh: { host: LOOPBACK, port: ssh.port, user: SSH_USER, auth: "password", password },
  };
}

beforeEach(async () => {
  ssh = await startSshServer();
  database = await startEchoServer();
  offers = [];
  reached = [];
});

afterEach(async () => {
  await ssh.close();
  await database.close();
});

describe("engine through an SSH tunnel", () => {
  it("givenSshPasswordAuth_whenConnect_thenQueriesRunThroughTunnel", async () => {
    const engine = createEngine({
      datasource: datasource(),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });
    const connection = engine.connect();
    const sessionId = await open(connection);

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1 AS one"));

    expect(result.columns.map((column) => column.name)).toEqual(["one"]);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.fingerprint).toMatch(/^SHA256:/);
    expect(reached).toHaveLength(1);
    expect(reached[0]?.host).toBe(LOOPBACK);
    expect(reached[0]?.port).not.toBe(database.port);
    expect(reached[0]?.serverName).toBe(LOOPBACK);
    await connection.close();
    await engine.close();
  });

  it("givenTwoSessions_whenOneCloses_thenTunnelStaysOpen", async () => {
    const engine = createEngine({
      datasource: datasource(),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });
    const connection = engine.connect();
    const first = await open(connection);
    const second = await open(connection);

    await closeSession(connection, first);
    const result = await execute(connection, second, "SELECT 1");

    expect(result.type).not.toBe("engine.error");
    expect(offers).toHaveLength(1);
    expect(new Set(reached.map((entry) => entry.port)).size).toBe(1);
    await connection.close();
    await engine.close();
  });

  it("givenLastSessionClosed_whenTunnelRefcountZero_thenTunnelCloses", async () => {
    const engine = createEngine({
      datasource: datasource(),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });
    const connection = engine.connect();
    await closeSession(connection, await open(connection));

    await open(connection);

    expect(offers).toHaveLength(2);
    expect(reached[1]?.port).not.toBe(reached[0]?.port);
    await connection.close();
    await engine.close();
  });

  it("givenTunnelDropped_whenNextQuery_thenReconnectReopensTunnel", async () => {
    const engine = createEngine({
      datasource: datasource(),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });
    const connection = engine.connect();
    const sessionId = await open(connection);

    ssh.dropClients();
    await waitFor(() => offers.length === 1 && reached.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));

    expect(result.reconnected).toBeDefined();
    expect(offers).toHaveLength(2);
    expect(reached).toHaveLength(2);
    await connection.close();
    await engine.close();
  });

  it("givenNoHostKeyVerifier_whenConnect_thenRefusesUnknownKey", async () => {
    const engine = createEngine({ datasource: datasource(), plugins: [networkedPlugin(reached)] });
    const connection = engine.connect();

    const response = await connection.handle({ id: 1, type: "session.open" });

    expect(response.type === "engine.error" ? response.error.code : null).toBe("sshHostKeyUnknown");
    expect(reached).toEqual([]);
    await connection.close();
    await engine.close();
  });
});

describe("probeDatasource through an SSH tunnel", () => {
  it("givenSshDatasource_whenProbed_thenReportsBothHops", async () => {
    const result = await probeDatasource({
      datasource: datasource(),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });

    expect(result.ok).toBe(true);
    expect(result.ssh).toMatchObject({ host: LOOPBACK, user: SSH_USER });
  });

  it("givenForwardRefused_whenProbed_thenNamesTheSshHopAndTheBastionsReason", async () => {
    ssh.refusedPorts.add(database.port);

    const result = await probeDatasource({
      datasource: datasource(),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });

    expect(result.ok).toBe(false);
    expect(result.ssh).toMatchObject({ host: LOOPBACK, user: SSH_USER });
    if (result.ok) return;
    expect(result.error.code).toBe("connectionFailed");
    expect(result.error.message).toContain(`the SSH server could not reach ${LOOPBACK}:${String(database.port)}`);
  });

  it("givenWrongSshPassword_whenProbed_thenSshAuthFailedWithoutHop", async () => {
    const result = await probeDatasource({
      datasource: datasource("wrong"),
      plugins: [networkedPlugin(reached)],
      verifyHostKey: trustAll,
    });

    expect(result.ok).toBe(false);
    expect(result.ssh).toBeUndefined();
    if (result.ok) return;
    expect(result.error.code).toBe("sshAuthFailed");
  });
});
