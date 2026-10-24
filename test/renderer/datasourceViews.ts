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
    ],
  },
];

export const POSTGRES_PLUGIN: PluginInfo = {
  id: "postgres",
  name: "PostgreSQL",
  unavailableReason: null,
  capabilities: ["sql", "cancel", "schemaTree"],
  fields: POSTGRES_FIELDS,
  highlight: "postgresql",
  url: {
    schemes: ["postgresql", "postgres"],
    form: "server",
    parts: { host: "host", port: "port", database: "database", user: "user", password: "password" },
    params: [{ name: "sslmode", key: "sslMode", values: { disable: "disable", require: "require" } }],
  },
  network: { host: "host", port: "port" },
};

export const SQLITE_PLUGIN: PluginInfo = {
  id: "sqlite",
  name: "SQLite",
  unavailableReason: null,
  capabilities: ["sql"],
  fields: [{ key: "path", label: "File", kind: "file", required: true }],
  highlight: "sqlite",
  url: { schemes: ["sqlite", "file"], form: "file", parts: { path: "path" } },
  network: null,
};
