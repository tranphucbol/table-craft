import { API_VERSION, pluginManifestSchema, type PluginManifest } from "@table-craft/plugin-api";
import mysqlJson from "../../plugins/mysql/table-craft-plugin.json" with { type: "json" };
import oracleJson from "../../plugins/oracle/table-craft-plugin.json" with { type: "json" };
import postgresJson from "../../plugins/postgres/table-craft-plugin.json" with { type: "json" };
import redisJson from "../../plugins/redis/table-craft-plugin.json" with { type: "json" };
import sqliteJson from "../../plugins/sqlite/table-craft-plugin.json" with { type: "json" };

/** The built-in manifests as shipped, so a test never restates one by hand. */
export const SQLITE_MANIFEST: PluginManifest = pluginManifestSchema.parse(sqliteJson);
export const POSTGRES_MANIFEST: PluginManifest = pluginManifestSchema.parse(postgresJson);
export const MYSQL_MANIFEST: PluginManifest = pluginManifestSchema.parse(mysqlJson);
export const REDIS_MANIFEST: PluginManifest = pluginManifestSchema.parse(redisJson);
export const ORACLE_MANIFEST: PluginManifest = pluginManifestSchema.parse(oracleJson);

/** A valid manifest for a fake plugin; the connection form is one optional text field. */
export function fakeManifest(overrides: Partial<PluginManifest> & { readonly id: string }): PluginManifest {
  return pluginManifestSchema.parse({
    name: overrides.id,
    version: "1.0.0",
    apiVersion: API_VERSION,
    entry: "index.mjs",
    capabilities: ["sql"],
    highlight: "sql",
    connection: { fields: [{ key: "path", label: "Path", kind: "text" }] },
    ...overrides,
  });
}
