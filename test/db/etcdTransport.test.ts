import { createConnector, type HostKeyOffer, type LoadedPlugin } from "@table-craft/core";
import { PluginError, type Session } from "@table-craft/plugin-api";
import etcd from "@table-craft/plugin-etcd";
import { describe, expect, it } from "vitest";
import {
  databaseEnabled,
  ETCD_TLS_BEHIND_BASTION,
  ETCD_TLS_CONFIG,
  SSH_BASTION,
  TLS_FILES,
} from "../support/databases.js";
import { ETCD_MANIFEST } from "../support/manifests.js";
import { serverQuery } from "../support/smokeFixtures.js";

const WRONG_HOST_NAME = "wrong-name.example";
const CONNECT_TIMEOUT_SECONDS = 3;
const PROBE_COMMAND = "get /seed/probe";
const CONFIG = { ...ETCD_TLS_CONFIG, connectTimeout: CONNECT_TIMEOUT_SECONDS };
const LOADED: LoadedPlugin = {
  status: "loaded",
  directory: "plugins/etcd",
  manifest: ETCD_MANIFEST,
  plugin: etcd,
};

async function assertProbe(session: Session): Promise<void> {
  const result = await session.execute(PROBE_COMMAND);
  const rows: unknown[][] = [];
  for await (const row of result.rows) rows.push([...row]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("1");
}

describe.skipIf(!databaseEnabled("etcd"))("etcd TLS, mTLS and SSH transport", () => {
  it("givenSeededMtlsServer_whenReadinessChecksGrpcSentinel_thenPresentKeyIsFound", async () => {
    expect(await serverQuery("etcd-tls", "/seed/probe")).toBe(true);
  });

  it("givenReachableMtlsServer_whenReadinessChecksAbsentKey_thenNotMistakenForSeeded", async () => {
    expect(await serverQuery("etcd-tls", "/seed/missing-readiness-probe")).toBe(false);
  });

  const connect = (overrides: Readonly<Record<string, unknown>> = {}, serverName?: string) =>
    etcd.connect({ ...CONFIG, ...overrides }, { readOnly: true, ...(serverName === undefined ? {} : { serverName }) });

  async function succeeds(overrides: Readonly<Record<string, unknown>> = {}, serverName?: string): Promise<void> {
    const session = await connect(overrides, serverName);
    try {
      await assertProbe(session);
    } finally {
      await session.close();
    }
  }

  async function fails(overrides: Readonly<Record<string, unknown>>, serverName?: string): Promise<PluginError> {
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

  it("givenTrustedServerAndClientCertificate_whenVerifyFull_thenReads", async () => {
    await succeeds();
  });

  it("givenWrongHostname_whenVerifyFull_thenRejectsHostname", async () => {
    const error = await fails({}, WRONG_HOST_NAME);
    expect(error.message).toContain(WRONG_HOST_NAME);
    expect(error.message).toMatch(/not valid|hostname|altname/i);
  });

  it("givenWrongHostname_whenVerifyCa_thenChecksChainWithoutHostname", async () => {
    await succeeds({ tlsMode: "verify-ca" }, WRONG_HOST_NAME);
  });

  for (const tlsMode of ["verify-full", "verify-ca"]) {
    it(`givenUntrustedCa_when${tlsMode}_thenRejectsCertificate`, async () => {
      const error = await fails({ tlsMode, tlsCa: TLS_FILES.wrongCa });
      expect(error.message).toMatch(/certificate|self.signed|CA/i);
    });
  }

  it("givenRequiredMtls_whenNoClientCertificate_thenRejects", async () => {
    const error = await fails({ tlsCert: "", tlsKey: "" });
    expect(error.message).toMatch(/certificate|TLS|socket|connection|RST_STREAM/i);
  });

  it("givenEncryptedClientKey_whenPassphraseProvided_thenReads", async () => {
    await succeeds({ tlsKey: TLS_FILES.encryptedClientKey, tlsKeyPassphrase: TLS_FILES.keyPassphrase });
  });

  it("givenSshAndVerifyFull_whenForwardedToLoopback_thenPreservesConfiguredHostname", async () => {
    const offers: HostKeyOffer[] = [];
    let forwarded: readonly { readonly host: string; readonly serverName: string }[] | undefined;
    const tunnel = createConnector({
      plugins: [
        {
          ...LOADED,
          plugin: {
            ...etcd,
            connect: (config, options) => {
              forwarded = options.transports;
              return etcd.connect(config, options);
            },
          },
        },
      ],
      pluginId: "etcd",
      config: { ...CONFIG, ...ETCD_TLS_BEHIND_BASTION },
      ssh: {
        host: SSH_BASTION.host,
        port: SSH_BASTION.port,
        user: SSH_BASTION.user,
        auth: "password",
        password: SSH_BASTION.password,
      },
      verifyHostKey: (offer) => {
        expect(offer.fingerprint).toBe(SSH_BASTION.fingerprint);
        offers.push(offer);
        return Promise.resolve();
      },
    });
    try {
      const session = await tunnel.connect({ readOnly: true });
      try {
        await assertProbe(session);
        expect(forwarded).toEqual([
          expect.objectContaining({ host: "127.0.0.1", serverName: ETCD_TLS_BEHIND_BASTION.host }),
        ]);
        expect(offers).toHaveLength(1);
      } finally {
        await session.close();
      }
    } finally {
      await tunnel.close();
    }
  });
});
