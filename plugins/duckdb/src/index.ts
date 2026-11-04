import { resolve } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { definePlugin, z, type ConnectOptions } from "@table-craft/plugin-api";
import { dataFileView } from "./dataFiles.js";
import { loadDriver, type DuckdbDriver } from "./driver.js";
import { connectFailure } from "./failures.js";
import { InstancePool, instanceOptions, type InstanceKey, type PooledInstance } from "./instances.js";
import { CAPABILITIES, language, quoteIdentifier } from "./language.js";
import { DuckdbSession } from "./session.js";

const PLUGIN_ID = "duckdb";
/** DuckDB's name for a database that lives only in this process. */
const MEMORY_PATH = ":memory:";
const SERVER_SQL = "SELECT version() AS version, current_database() AS database";
const VERSION_PREFIX = /^v/u;

const connectionSchema = z.strictObject({
  path: z.string().min(1),
  readOnlyFile: z.boolean().default(false),
  downloadExtensions: z.boolean().default(true),
});

type DuckdbConfig = z.infer<typeof connectionSchema>;

const instances = new InstancePool();

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A database no other session sees: `:memory:`, or the in-memory one a data file is viewed through. */
async function privateInstance(driver: DuckdbDriver, key: InstanceKey): Promise<PooledInstance> {
  const instance = await driver.DuckDBInstance.create(MEMORY_PATH, instanceOptions(key));
  return { instance, release: () => instance.closeSync() };
}

async function connections(instance: DuckDBInstance): Promise<[DuckDBConnection, DuckDBConnection]> {
  const connection = await instance.connect();
  try {
    return [connection, await instance.connect()];
  } catch (cause) {
    connection.closeSync();
    throw cause;
  }
}

async function connect(config: DuckdbConfig, options: ConnectOptions): Promise<DuckdbSession> {
  const path = config.path.trim();
  const view = dataFileView(path);
  const isPrivate = path === MEMORY_PATH || view !== null;
  const key: InstanceKey = {
    path: isPrivate ? MEMORY_PATH : resolve(path),
    readOnlyFile: config.readOnlyFile,
    downloadExtensions: config.downloadExtensions,
  };
  let opened: PooledInstance;
  let driver: DuckdbDriver;
  try {
    driver = await loadDriver();
    opened = isPrivate ? await privateInstance(driver, key) : await instances.acquire(key);
  } catch (cause) {
    throw connectFailure(cause, path);
  }
  let pair: [DuckDBConnection, DuckDBConnection] | null = null;
  try {
    pair = await connections(opened.instance);
    const [connection, metadata] = pair;
    if (view !== null) {
      (
        await connection.run(`CREATE VIEW ${quoteIdentifier(view.view)} AS FROM ${language.literal(view.source, null)}`)
      ).closeSync();
    }
    const server = (await connection.runAndReadAll(SERVER_SQL)).getRowObjectsJson()[0] ?? {};
    return new DuckdbSession({
      driver,
      connection,
      metadata,
      readOnly: options.readOnly,
      privateDatabase: isPrivate,
      serverVersion: textOf(server.version).replace(VERSION_PREFIX, ""),
      openedDatabase: textOf(server.database),
      release: () => {
        opened.release();
      },
    });
  } catch (cause) {
    pair?.forEach((connection) => connection.closeSync());
    opened.release();
    throw connectFailure(cause, path);
  }
}

export default definePlugin({
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  language,
  connectionSchema,
  connect,
});
