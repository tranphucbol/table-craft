import type { ConnectionField, DatasourceView, PluginInfo } from "@table-craft/desktop/preload/bridge.js";

export function view(overrides: Partial<DatasourceView> & Pick<DatasourceView, "id" | "name">): DatasourceView {
  return {
    pluginId: "postgres",
    folder: null,
    color: null,
    readOnly: false,
    comment: "",
    config: {},
    secretModes: {},
    storedSecrets: [],
    ephemeral: false,
    ...overrides,
  };
}

const POSTGRES_FIELDS: readonly ConnectionField[] = [
  { key: "host", label: "Host", kind: "text", default: "localhost", required: true },
  { key: "port", label: "Port", kind: "number", default: 5432 },
  { key: "database", label: "Database", kind: "text", placeholder: "optional" },
  { key: "user", label: "User", kind: "text", required: true },
  { key: "password", label: "Password", kind: "password", secret: true },
  {
    key: "sslMode",
    label: "SSL mode",
    kind: "select",
    default: "disable",
    group: "advanced",
    options: [
      { value: "disable", label: "Disable" },
      { value: "require", label: "Require" },
      { value: "verify-ca", label: "Verify CA" },
      { value: "verify-full", label: "Verify full" },
    ],
  },
  { key: "sslRootCert", label: "SSL root certificate", kind: "file", group: "advanced" },
  { key: "sslCert", label: "Client certificate", kind: "file", group: "advanced" },
  { key: "sslKey", label: "Client key", kind: "file", group: "advanced" },
  { key: "sslKeyPassphrase", label: "Client key passphrase", kind: "password", secret: true, group: "advanced" },
];

export const POSTGRES_PLUGIN: PluginInfo = {
  id: "postgres",
  name: "PostgreSQL",
  source: "managed",
  version: "1.0.0",
  unavailableReason: null,
  capabilities: ["sql", "cancel", "schemaTree"],
  fields: POSTGRES_FIELDS,
  highlight: "postgresql",
  brands: [{ id: "postgresql", name: "PostgreSQL" }],
  url: {
    schemes: ["postgresql", "postgres"],
    form: "server",
    parts: { host: "host", port: "port", database: "database", user: "user", password: "password" },
    params: [{ name: "sslmode", key: "sslMode", values: { disable: "disable", require: "require" } }],
  },
  network: { host: "host", port: "port" },
  tls: {
    mode: "sslMode",
    verifyModes: ["verify-ca", "verify-full"],
    caFile: "sslRootCert",
    certFile: "sslCert",
    keyFile: "sslKey",
    keyPassphrase: "sslKeyPassphrase",
  },
};

export const SQLITE_PLUGIN: PluginInfo = {
  id: "sqlite",
  name: "SQLite",
  source: "builtIn",
  version: "1.0.0",
  unavailableReason: null,
  capabilities: ["sql"],
  fields: [{ key: "path", label: "File", kind: "file", required: true }],
  highlight: "sqlite",
  brands: [{ id: "sqlite", name: "SQLite" }],
  url: { schemes: ["sqlite", "file"], form: "file", parts: { path: "path" } },
  network: null,
  tls: null,
};

export const REDIS_PLUGIN: PluginInfo = {
  id: "redis",
  name: "Redis",
  source: "managed",
  version: "1.0.0",
  unavailableReason: null,
  capabilities: ["commands", "keyValue"],
  fields: [
    {
      key: "mode",
      label: "Mode",
      kind: "select",
      default: "standalone",
      options: [
        { value: "standalone", label: "Standalone" },
        { value: "sentinel", label: "Sentinel" },
        { value: "cluster", label: "Cluster" },
      ],
    },
    { key: "host", label: "Host", kind: "text", default: "localhost", required: true },
    { key: "port", label: "Port", kind: "number", default: 6379 },
    {
      key: "masterName",
      label: "Master name",
      kind: "text",
      default: "mymaster",
      required: true,
      visibleWhen: { key: "mode", equals: "sentinel" },
    },
    {
      key: "database",
      label: "Database",
      kind: "number",
      default: 0,
      required: true,
      visibleWhen: { key: "mode", equals: ["standalone", "sentinel"] },
    },
  ],
  highlight: "redis",
  brands: [{ id: "redis", name: "Redis" }],
  url: null,
  network: null,
  tls: null,
};
