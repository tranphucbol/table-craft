import {
  TunnelError,
  createConnector,
  type HostKeyOffer,
  type LoadedPlugin,
  type SshEndpoint,
} from "@table-craft/core";
import type { DatasourcePlugin, PluginManifest, Session } from "@table-craft/plugin-api";
import mssql from "@table-craft/plugin-mssql";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import { describe, expect, it } from "vitest";
import {
  MSSQL_BEHIND_BASTION,
  MSSQL_CONFIG,
  MYSQL_BEHIND_BASTION,
  MYSQL_CONFIG,
  ORACLE_BEHIND_BASTION,
  ORACLE_CONFIG,
  POSTGRES_BEHIND_BASTION,
  POSTGRES_CONFIG,
  SSH_BASTION,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import { MSSQL_MANIFEST, MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

const PASSWORD_AUTH: SshEndpoint = {
  host: SSH_BASTION.host,
  port: SSH_BASTION.port,
  user: SSH_BASTION.user,
  auth: "password",
  password: SSH_BASTION.password,
};
const KEY_AUTH: SshEndpoint = {
  host: SSH_BASTION.host,
  port: SSH_BASTION.port,
  user: SSH_BASTION.user,
  auth: "key",
  keyPath: SSH_BASTION.keyPath,
  passphrase: SSH_BASTION.passphrase,
};

interface Target {
  readonly name: DatabaseId;
  readonly plugin: DatasourcePlugin;
  readonly manifest: PluginManifest;
  readonly config: Readonly<Record<string, unknown>>;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: postgres,
    manifest: POSTGRES_MANIFEST,
    config: { ...POSTGRES_CONFIG, ...POSTGRES_BEHIND_BASTION },
  },
  { name: "mysql", plugin: mysql, manifest: MYSQL_MANIFEST, config: { ...MYSQL_CONFIG, ...MYSQL_BEHIND_BASTION } },
  {
    name: "oracle",
    plugin: oracle,
    manifest: ORACLE_MANIFEST,
    config: { ...ORACLE_CONFIG, ...ORACLE_BEHIND_BASTION },
  },
  { name: "mssql", plugin: mssql, manifest: MSSQL_MANIFEST, config: { ...MSSQL_CONFIG, ...MSSQL_BEHIND_BASTION } },
];

function loaded(target: Target): LoadedPlugin {
  return { status: "loaded", directory: `plugins/${target.name}`, manifest: target.manifest, plugin: target.plugin };
}

async function firstValue(session: Session, sql: string): Promise<unknown> {
  const result = await session.execute(sql);
  const rows: unknown[][] = [];
  for await (const row of result.rows) rows.push([...row]);
  return rows[0]?.[0];
}

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(`${target.name} through the SSH bastion`, () => {
    const connector = (ssh: SshEndpoint, offers: HostKeyOffer[] = []) =>
      createConnector({
        plugins: [loaded(target)],
        pluginId: target.name,
        config: target.config,
        ssh,
        verifyHostKey: (offer) => {
          offers.push(offer);
          return Promise.resolve();
        },
      });

    it("givenSshPasswordAuth_whenConnect_thenQueriesRunThroughTunnel", async () => {
      const offers: HostKeyOffer[] = [];
      const tunnel = connector(PASSWORD_AUTH, offers);
      try {
        const session = await tunnel.connect({ readOnly: false });
        try {
          expect(String(await firstValue(session, "SELECT 40 + 2"))).toBe("42");
        } finally {
          await session.close();
        }
        expect(offers.map((offer) => offer.fingerprint)).toEqual([SSH_BASTION.fingerprint]);
        expect(tunnel.hop).toMatchObject({ host: SSH_BASTION.host, user: SSH_BASTION.user });
      } finally {
        await tunnel.close();
      }
    });

    it("givenKeyWithPassphrase_whenConnect_thenTunnelOpens", async () => {
      const tunnel = connector(KEY_AUTH);
      try {
        const sessions = await Promise.all([tunnel.connect({ readOnly: true }), tunnel.connect({ readOnly: true })]);
        for (const session of sessions) expect(String(await firstValue(session, "SELECT 7"))).toBe("7");
        await Promise.all(sessions.map((session) => session.close()));
      } finally {
        await tunnel.close();
      }
    });

    it("givenWrongPassword_whenConnect_thenSshAuthFailed", async () => {
      const tunnel = connector({ ...PASSWORD_AUTH, password: "not-the-password" });
      try {
        const failure: unknown = await tunnel.connect({ readOnly: false }).catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(TunnelError);
        expect(failure).toMatchObject({ code: "sshAuthFailed" });
      } finally {
        await tunnel.close();
      }
    });
  });
}
