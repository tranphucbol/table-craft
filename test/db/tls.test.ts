import { createConnector, type LoadedPlugin } from "@table-craft/core";
import { PluginError, type DatasourcePlugin, type PluginManifest, type Session } from "@table-craft/plugin-api";
import mssql from "@table-craft/plugin-mssql";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { describe, expect, it } from "vitest";
import {
  MSSQL_BEHIND_BASTION,
  MSSQL_TLS_CONFIG,
  MYSQL_TLS_BEHIND_BASTION,
  MYSQL_TLS_CONFIG,
  POSTGRES_TLS_BEHIND_BASTION,
  POSTGRES_TLS_CONFIG,
  SSH_BASTION,
  TLS_FILES,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import { MSSQL_MANIFEST, MYSQL_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

/** No certificate names this host, so it stands in for a server reached under the wrong name. */
const WRONG_HOST_NAME = "wrong-name.example";
const MISSING_KEY = "/nonexistent/table-craft/client.key";
const TLS_PROTOCOL = /^TLSv1\.[23]$/;

interface Target {
  readonly name: DatabaseId;
  readonly plugin: DatasourcePlugin;
  readonly manifest: PluginManifest;
  readonly config: Readonly<Record<string, unknown>>;
  readonly behindBastion: { readonly host: string; readonly port: number };
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: postgres,
    manifest: POSTGRES_MANIFEST,
    config: POSTGRES_TLS_CONFIG,
    behindBastion: POSTGRES_TLS_BEHIND_BASTION,
  },
  {
    name: "mysql",
    plugin: mysql,
    manifest: MYSQL_MANIFEST,
    config: MYSQL_TLS_CONFIG,
    behindBastion: MYSQL_TLS_BEHIND_BASTION,
  },
];

/** The client certificate is the only credential: `tc_cert` has no password on either server. */
const CERT_USER = { user: TLS_FILES.certUser, password: "", sslCert: TLS_FILES.clientCert };

async function firstValue(session: Session, sql: string): Promise<unknown> {
  const result = await session.execute(sql);
  const rows: unknown[][] = [];
  for await (const row of result.rows) rows.push([...row]);
  return rows[0]?.[0];
}

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(`${target.name} over TLS`, () => {
    const connect = (overrides: Readonly<Record<string, unknown>>, serverName?: string) =>
      target.plugin.connect(
        { ...target.config, ...overrides },
        serverName === undefined ? { readOnly: false } : { readOnly: false, serverName },
      );

    async function connectsAndQueries(overrides: Readonly<Record<string, unknown>>, serverName?: string) {
      const session = await connect(overrides, serverName);
      try {
        expect(await firstValue(session, "SELECT note FROM tls_probe")).toBe("reached over TLS");
        return session.tls;
      } finally {
        await session.close();
      }
    }

    async function failure(overrides: Readonly<Record<string, unknown>>, serverName?: string): Promise<PluginError> {
      const cause: unknown = await connect(overrides, serverName).then(
        async (session) => {
          await session.close();
          return null;
        },
        (error: unknown) => error,
      );
      expect(cause).toBeInstanceOf(PluginError);
      expect(cause).toMatchObject({ code: "connectionFailed" });
      return cause as PluginError;
    }

    it("givenRequire_whenConnected_thenTlsDescribed", async () => {
      const tls = await connectsAndQueries({ sslMode: "require" });
      expect(tls?.protocol).toMatch(TLS_PROTOCOL);
      expect(tls?.cipher).not.toBe("");
    });

    it("givenVerifyFullWithCa_whenConnect_thenConnects", async () => {
      await connectsAndQueries({ sslMode: "verify-full", sslRootCert: TLS_FILES.ca });
    });

    it("givenVerifyCaWithCa_whenConnect_thenConnects", async () => {
      await connectsAndQueries({ sslMode: "verify-ca", sslRootCert: TLS_FILES.ca });
    });

    it("givenVerifyFullWithoutCa_whenConnect_thenAsksForCaFile", async () => {
      const error = await failure({ sslMode: "verify-full" });
      expect(error.message).toContain("not signed by a CA this system trusts");
      expect(error.message).toContain("SSL root certificate");
    });

    it("givenWrongCa_whenVerifyCa_thenFailsNamingCertificate", async () => {
      const error = await failure({ sslMode: "verify-ca", sslRootCert: TLS_FILES.wrongCa });
      expect(error.message).toContain(`not signed by the CA in ${TLS_FILES.wrongCa}`);
    });

    it("givenWrongHostName_whenVerifyFull_thenFailsNamingHost", async () => {
      const error = await failure({ sslMode: "verify-full", sslRootCert: TLS_FILES.ca }, WRONG_HOST_NAME);
      expect(error.message).toContain(`not valid for host ${WRONG_HOST_NAME}`);
    });

    it("givenWrongHostName_whenVerifyCa_thenConnects", async () => {
      await connectsAndQueries({ sslMode: "verify-ca", sslRootCert: TLS_FILES.ca }, WRONG_HOST_NAME);
    });

    it("givenClientCertUser_whenCertAndKey_thenAuthenticates", async () => {
      await connectsAndQueries({
        ...CERT_USER,
        sslMode: "verify-full",
        sslRootCert: TLS_FILES.ca,
        sslKey: TLS_FILES.clientKey,
      });
    });

    it("givenEncryptedKey_whenPassphrase_thenAuthenticates", async () => {
      await connectsAndQueries({
        ...CERT_USER,
        sslMode: "require",
        sslKey: TLS_FILES.encryptedClientKey,
        sslKeyPassphrase: TLS_FILES.keyPassphrase,
      });
    });

    it("givenEncryptedKeyWithoutPassphrase_whenConnect_thenSaysPassphrase", async () => {
      const error = await failure({ ...CERT_USER, sslMode: "require", sslKey: TLS_FILES.encryptedClientKey });
      expect(error.message).toContain(`Cannot decrypt the Client key ${TLS_FILES.encryptedClientKey}`);
    });

    it("givenMissingKeyFile_whenConnect_thenErrorNamesField", async () => {
      const error = await failure({ ...CERT_USER, sslMode: "require", sslKey: MISSING_KEY });
      expect(error.message).toBe(`Cannot read the Client key ${MISSING_KEY}: the file does not exist.`);
    });

    it("givenTunnelAndVerifyFull_whenConnect_thenChecksConfiguredHost", async () => {
      const loaded: LoadedPlugin = {
        status: "loaded",
        directory: `plugins/${target.name}`,
        manifest: target.manifest,
        plugin: target.plugin,
      };
      const tunnel = createConnector({
        plugins: [loaded],
        pluginId: target.name,
        config: { ...target.config, ...target.behindBastion, sslMode: "verify-full", sslRootCert: TLS_FILES.ca },
        ssh: {
          host: SSH_BASTION.host,
          port: SSH_BASTION.port,
          user: SSH_BASTION.user,
          auth: "password",
          password: SSH_BASTION.password,
        },
        verifyHostKey: () => Promise.resolve(),
      });
      try {
        const session = await tunnel.connect({ readOnly: false });
        try {
          expect(await firstValue(session, "SELECT note FROM tls_probe")).toBe("reached over TLS");
          expect(session.tls?.protocol).toMatch(TLS_PROTOCOL);
        } finally {
          await session.close();
        }
      } finally {
        await tunnel.close();
      }
    });
  });
}

/** SQL Server has no client certificates: its cases are the encrypt modes and the CA check. */
describe.skipIf(!databaseEnabled("mssql"))("mssql over TLS", () => {
  const connect = (overrides: Readonly<Record<string, unknown>>, serverName?: string) =>
    mssql.connect(
      mssql.connectionSchema.parse({ ...MSSQL_TLS_CONFIG, ...overrides }),
      serverName === undefined ? { readOnly: false } : { readOnly: false, serverName },
    );

  async function connectsAndQueries(overrides: Readonly<Record<string, unknown>>, serverName?: string) {
    const session = await connect(overrides, serverName);
    try {
      expect(await firstValue(session, "SELECT note FROM tls_probe")).toBe("reached over TLS");
      return session.tls;
    } finally {
      await session.close();
    }
  }

  async function failure(overrides: Readonly<Record<string, unknown>>, serverName?: string): Promise<PluginError> {
    const cause: unknown = await connect(overrides, serverName).then(
      async (session) => {
        await session.close();
        return null;
      },
      (error: unknown) => error,
    );
    expect(cause).toBeInstanceOf(PluginError);
    expect(cause).toMatchObject({ code: "connectionFailed" });
    return cause as PluginError;
  }

  it("givenMandatoryWithCa_whenConnected_thenTlsDescribed", async () => {
    const tls = await connectsAndQueries({ sslRootCert: TLS_FILES.ca });
    expect(tls?.protocol).toMatch(TLS_PROTOCOL);
    expect(tls?.cipher).not.toBe("");
  });

  it("givenOptional_whenConnected_thenNoTls", async () => {
    expect(await connectsAndQueries({ encrypt: "optional" })).toBeNull();
  });

  it("givenTrustServerCertificate_whenNoCa_thenConnects", async () => {
    await connectsAndQueries({ trustServerCertificate: true });
  });

  it("givenMandatoryWithoutCa_whenConnect_thenAsksForCaFile", async () => {
    const error = await failure({});
    expect(error.message).toContain("not signed by a CA this system trusts");
    expect(error.message).toContain("Server CA certificate");
  });

  it("givenWrongCa_whenMandatory_thenFailsNamingCertificate", async () => {
    const error = await failure({ sslRootCert: TLS_FILES.wrongCa });
    expect(error.message).toContain(`not signed by the CA in ${TLS_FILES.wrongCa}`);
  });

  it("givenWrongHostName_whenMandatory_thenFailsNamingHost", async () => {
    const error = await failure({ sslRootCert: TLS_FILES.ca }, WRONG_HOST_NAME);
    expect(error.message).toContain(`not valid for host ${WRONG_HOST_NAME}`);
  });

  it("givenTunnelAndMandatory_whenConnect_thenChecksConfiguredHost", async () => {
    const tunnel = createConnector({
      plugins: [{ status: "loaded", directory: "plugins/mssql", manifest: MSSQL_MANIFEST, plugin: mssql }],
      pluginId: "mssql",
      config: { ...MSSQL_TLS_CONFIG, ...MSSQL_BEHIND_BASTION, sslRootCert: TLS_FILES.ca },
      ssh: {
        host: SSH_BASTION.host,
        port: SSH_BASTION.port,
        user: SSH_BASTION.user,
        auth: "password",
        password: SSH_BASTION.password,
      },
      verifyHostKey: () => Promise.resolve(),
    });
    try {
      const session = await tunnel.connect({ readOnly: false });
      try {
        expect(await firstValue(session, "SELECT note FROM tls_probe")).toBe("reached over TLS");
        expect(session.tls?.protocol).toMatch(TLS_PROTOCOL);
      } finally {
        await session.close();
      }
    } finally {
      await tunnel.close();
    }
  });
});
