import { API_VERSION, pluginManifestSchema, z, type PluginManifest } from "@table-craft/plugin-api";
import { connectionFormProblems } from "@table-craft/plugin-api/testing";
import { describe, expect, it } from "vitest";

const VALID_MANIFEST = {
  id: "sqlite",
  name: "SQLite",
  version: "1.0.0",
  apiVersion: API_VERSION,
  entry: "index.js",
  capabilities: ["sql"],
  highlight: "sqlite",
  connection: { fields: [{ key: "path", label: "File", kind: "file", required: true }] },
};

const SERVER_SCHEMA = z.strictObject({
  host: z.string(),
  user: z.string(),
  password: z.string().default(""),
});

function serverManifest(fields: readonly unknown[], url?: unknown): PluginManifest {
  return pluginManifestSchema.parse({ ...VALID_MANIFEST, id: "server", connection: { fields, url } });
}

const SERVER_URL = {
  schemes: ["server"],
  form: "server",
  parts: { host: "host", user: "user", password: "password" },
};

const HOST = { key: "host", label: "Host", kind: "text", required: true };
const USER = { key: "user", label: "User", kind: "text", required: true };
const PASSWORD = { key: "password", label: "Password", kind: "password", secret: true };

describe("pluginManifestSchema", () => {
  it("givenValidManifest_whenParsed_thenReturnsManifest", () => {
    expect(pluginManifestSchema.parse(VALID_MANIFEST)).toEqual(VALID_MANIFEST);
  });

  it("givenUnknownCapability_whenParsed_thenFails", () => {
    const result = pluginManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities: ["teleport"] });
    expect(result.success).toBe(false);
  });

  it("givenDdlWithoutSchemaTree_whenParsed_thenFails", () => {
    expect(pluginManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities: ["sql", "ddl"] }).success).toBe(false);
    expect(
      pluginManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities: ["sql", "schemaTree", "ddl"] }).success,
    ).toBe(true);
  });

  it("givenExplainAnalyzeWithoutExplain_whenParsed_thenFails", () => {
    const parses = (capabilities: string[]): boolean =>
      pluginManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities }).success;
    expect(parses(["sql", "explainAnalyze"])).toBe(false);
    expect(parses(["explain"])).toBe(false);
    expect(parses(["sql", "explain"])).toBe(true);
    expect(parses(["sql", "explain", "explainAnalyze"])).toBe(true);
  });

  it("givenCurrentNamespaceWithoutSql_whenParsed_thenFails", () => {
    const parses = (capabilities: string[]): boolean =>
      pluginManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities }).success;
    expect(parses(["currentNamespace"])).toBe(false);
    expect(parses(["sql", "currentNamespace"])).toBe(true);
  });

  it("givenSessionsWithoutSqlOrSchemaTree_whenParsed_thenFails", () => {
    const parses = (capabilities: string[]): boolean =>
      pluginManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities }).success;
    expect(parses(["sessions"])).toBe(false);
    expect(parses(["sql", "sessions"])).toBe(false);
    expect(parses(["schemaTree", "sessions"])).toBe(false);
    expect(parses(["sql", "schemaTree", "sessions"])).toBe(true);
  });

  it("givenNonSemverApiVersion_whenParsed_thenFails", () => {
    const result = pluginManifestSchema.safeParse({ ...VALID_MANIFEST, apiVersion: "latest" });
    expect(result.success).toBe(false);
  });

  it("givenUnknownField_whenParsed_thenFails", () => {
    const result = pluginManifestSchema.safeParse({ ...VALID_MANIFEST, main: "index.js" });
    expect(result.success).toBe(false);
  });

  it("givenNoConnectionForm_whenParsed_thenFails", () => {
    const { connection: _omitted, ...withoutForm } = VALID_MANIFEST;
    expect(pluginManifestSchema.safeParse(withoutForm).success).toBe(false);
  });

  it("givenUnknownFieldKind_whenParsed_thenFails", () => {
    const fields = [{ key: "path", label: "File", kind: "colour" }];
    expect(pluginManifestSchema.safeParse({ ...VALID_MANIFEST, connection: { fields } }).success).toBe(false);
  });
});

describe("pluginManifestSchema network", () => {
  const PORT = { key: "port", label: "Port", kind: "number" };
  const TIMEOUT = { key: "connectTimeout", label: "Timeout", kind: "number" };
  const parses = (fields: readonly unknown[], network: unknown): boolean =>
    pluginManifestSchema.safeParse({ ...VALID_MANIFEST, id: "server", connection: { fields, network } }).success;

  it("givenNetworkNamingDeclaredFields_whenParsed_thenAccepted", () => {
    expect(parses([HOST, PORT, TIMEOUT], { host: "host", port: "port", connectTimeout: "connectTimeout" })).toBe(true);
    expect(parses([HOST, PORT], { host: "host", port: "port" })).toBe(true);
  });

  it("givenManifestNetworkNamingMissingField_whenParsed_thenRejected", () => {
    expect(parses([HOST], { host: "host", port: "port" })).toBe(false);
    expect(parses([HOST, PORT], { host: "host", port: "port", connectTimeout: "connectTimeout" })).toBe(false);
  });

  it("givenNetworkNamingFieldOfWrongKind_whenParsed_thenRejected", () => {
    expect(parses([HOST, { ...PORT, kind: "text" }], { host: "host", port: "port" })).toBe(false);
    expect(parses([HOST, PORT], { host: "port", port: "host" })).toBe(false);
  });
});

describe("pluginManifestSchema tls", () => {
  const MODE = {
    key: "sslMode",
    label: "SSL mode",
    kind: "select",
    options: [
      { value: "disable", label: "Disable" },
      { value: "verify-ca", label: "Verify CA" },
      { value: "verify-full", label: "Verify full" },
    ],
  };
  const CA = { key: "sslRootCert", label: "SSL root certificate", kind: "file" };
  const CERT = { key: "sslCert", label: "Client certificate", kind: "file" };
  const KEY = { key: "sslKey", label: "Client key", kind: "file" };
  const PASSPHRASE = { key: "sslKeyPassphrase", label: "Client key passphrase", kind: "password", secret: true };
  const TLS = {
    mode: "sslMode",
    verifyModes: ["verify-ca", "verify-full"],
    caFile: "sslRootCert",
    certFile: "sslCert",
    keyFile: "sslKey",
    keyPassphrase: "sslKeyPassphrase",
  };
  const parses = (fields: readonly unknown[], tls: unknown): boolean =>
    pluginManifestSchema.safeParse({ ...VALID_MANIFEST, id: "server", connection: { fields, tls } }).success;

  it("givenTlsNamingDeclaredFields_whenParsed_thenAccepted", () => {
    expect(parses([MODE, CA, CERT, KEY, PASSPHRASE], TLS)).toBe(true);
    expect(parses([MODE, CA], { mode: "sslMode", verifyModes: ["verify-full"], caFile: "sslRootCert" })).toBe(true);
  });

  it("givenTlsNamingMissingField_whenParsed_thenRejected", () => {
    expect(parses([MODE, CA, CERT, KEY], TLS)).toBe(false);
    expect(parses([CA, CERT, KEY, PASSPHRASE], TLS)).toBe(false);
  });

  it("givenTlsVerifyModeTheSelectLacks_whenParsed_thenRejected", () => {
    expect(parses([MODE, CA], { mode: "sslMode", verifyModes: ["verify-identity"], caFile: "sslRootCert" })).toBe(
      false,
    );
    expect(parses([MODE], { mode: "sslMode", verifyModes: [] })).toBe(false);
  });

  it("givenTlsNamingFieldOfWrongKind_whenParsed_thenRejected", () => {
    expect(
      parses([MODE, { ...CA, kind: "text" }], { mode: "sslMode", verifyModes: ["verify-ca"], caFile: "sslRootCert" }),
    ).toBe(false);
    const passphrase = { mode: "sslMode", verifyModes: ["verify-ca"], keyPassphrase: "sslKeyPassphrase" };
    expect(parses([MODE, { ...PASSPHRASE, secret: false }], passphrase)).toBe(false);
    expect(
      parses([{ ...MODE, kind: "text", options: undefined }], { mode: "sslMode", verifyModes: ["verify-ca"] }),
    ).toBe(false);
  });
});

describe("connectionFormProblems", () => {
  it("givenAgreeingFormAndSchema_whenCompared_thenNoProblems", () => {
    expect(connectionFormProblems(serverManifest([HOST, USER, PASSWORD]), SERVER_SCHEMA)).toEqual([]);
  });

  it("givenPasswordFieldNotSecret_whenContractRuns_thenFails", () => {
    const leaky = serverManifest([HOST, USER, { ...PASSWORD, secret: false }]);

    expect(connectionFormProblems(leaky, SERVER_SCHEMA)).toEqual(['Password field "password" must be marked secret.']);
  });

  it("givenFieldTheSchemaRejects_whenCompared_thenNamesIt", () => {
    const extra = serverManifest([HOST, USER, PASSWORD, { key: "schema", label: "Schema", kind: "text" }]);

    expect(connectionFormProblems(extra, SERVER_SCHEMA)).toEqual([
      'Field "schema" is not accepted by connectionSchema.',
    ]);
  });

  it("givenRequiredKeyWithoutField_whenCompared_thenNamesIt", () => {
    expect(connectionFormProblems(serverManifest([HOST, PASSWORD]), SERVER_SCHEMA)).toEqual([
      'connectionSchema requires "user", but no connection field fills it.',
    ]);
  });

  it("givenUrlAgreeingWithFields_whenCompared_thenNoProblems", () => {
    expect(connectionFormProblems(serverManifest([HOST, USER, PASSWORD], SERVER_URL), SERVER_SCHEMA)).toEqual([]);
  });

  it("givenUrlPartsAndParamsTheFormLacks_whenCompared_thenNamesEach", () => {
    const url = {
      ...SERVER_URL,
      parts: { host: "host", user: "password", path: "host" },
      params: [
        { name: "role", key: "role" },
        { name: "pw", key: "password" },
      ],
    };

    expect(connectionFormProblems(serverManifest([HOST, USER, PASSWORD], url), SERVER_SCHEMA)).toEqual([
      'URL part "user" fills "password", but only the password part fills a secret field.',
      'A server URL has no "path" part.',
      'URL parameter "role" fills "role", which no connection field declares.',
      'URL parameter "pw" must not fill a secret field.',
    ]);
  });
});

describe("pluginManifestSchema url", () => {
  it("givenUppercaseScheme_whenParsed_thenFails", () => {
    const parses = (schemes: string[]): boolean =>
      pluginManifestSchema.safeParse({
        ...VALID_MANIFEST,
        connection: { ...VALID_MANIFEST.connection, url: { schemes, form: "file", parts: { path: "path" } } },
      }).success;

    expect(parses(["sqlite"])).toBe(true);
    expect(parses(["SQLite"])).toBe(false);
    expect(parses([])).toBe(false);
  });
});
