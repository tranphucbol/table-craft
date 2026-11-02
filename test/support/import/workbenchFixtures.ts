import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MySQL Workbench `connections.xml` fixtures in the shape Workbench 8.0 writes (plan 143): a GRT
 * document whose list holds one `db.mgmt.Connection` object per connection. Names, hosts and users
 * are made up.
 */
export interface WorkbenchFixtureConnection {
  readonly id: string;
  readonly name: string;
  /** The suffix after `com.mysql.rdbms.mysql.driver.`. */
  readonly driver: string;
  /** Omitted to test the template fallback. */
  readonly hostIdentifier?: string;
  readonly parameters: Readonly<Record<string, string | number>>;
}

export const WORKBENCH_IDS = {
  shop: "{2B5C1D1E-0000-4000-8000-000000000001}",
  socket: "{2B5C1D1E-0000-4000-8000-000000000002}",
  sshKey: "{2B5C1D1E-0000-4000-8000-000000000003}",
  sshPassword: "{2B5C1D1E-0000-4000-8000-000000000004}",
  verifyCa: "{2B5C1D1E-0000-4000-8000-000000000005}",
  ldap: "{2B5C1D1E-0000-4000-8000-000000000006}",
  kerberos: "{2B5C1D1E-0000-4000-8000-000000000007}",
  noIdentifier: "{2B5C1D1E-0000-4000-8000-000000000008}",
} as const;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parameter(key: string, value: string | number): string {
  const type = typeof value === "number" ? "int" : "string";
  return `        <value type="${type}" key="${escape(key)}">${escape(String(value))}</value>`;
}

export function workbenchXml(connections: readonly WorkbenchFixtureConnection[]): string {
  const objects = connections.map((connection) =>
    [
      `    <value type="object" struct-name="db.mgmt.Connection" id="${connection.id}" struct-checksum="0x96ba47d8">`,
      `      <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.${connection.driver}</link>`,
      ...(connection.hostIdentifier === undefined
        ? []
        : [`      <value type="string" key="hostIdentifier">${escape(connection.hostIdentifier)}</value>`]),
      `      <value type="int" key="isDefault">0</value>`,
      `      <value _ptr_="0x6000012" type="dict" key="modules"/>`,
      `      <value _ptr_="0x6000013" type="dict" key="parameterValues">`,
      ...Object.entries(connection.parameters).map(([key, value]) => parameter(key, value)),
      `      </value>`,
      `      <value type="string" key="name">${escape(connection.name)}</value>`,
      `      <link type="object" struct-name="GrtObject" key="owner">{2B5C1D1E-0000-4000-8000-0000000000FF}</link>`,
      `    </value>`,
    ].join("\n"),
  );
  return [
    '<?xml version="1.0"?>',
    '<data grt_format="2.0">',
    '  <value _ptr_="0x6000010" type="list" content-type="object" content-struct-name="db.mgmt.Connection">',
    ...objects,
    "  </value>",
    "</data>",
    "",
  ].join("\n");
}

/** One connection of each kind the reader tells apart. */
export function workbenchConnections(mysql: { host: string; port: number }): WorkbenchFixtureConnection[] {
  const address = `${mysql.host}:${String(mysql.port)}`;
  return [
    {
      id: WORKBENCH_IDS.shop,
      name: "Docker/Shop MySQL",
      driver: "native",
      hostIdentifier: `Mysql@${address}`,
      parameters: {
        hostName: mysql.host,
        port: mysql.port,
        userName: "table_craft",
        schema: "table_craft",
        useSSL: 0,
        CLIENT_COMPRESS: 0,
        SQL_MODE: "",
      },
    },
    {
      id: WORKBENCH_IDS.socket,
      name: "Local socket",
      driver: "native_socket",
      hostIdentifier: "Mysql@local:/tmp/mysql.sock",
      parameters: { socket: "/tmp/mysql.sock", userName: "root" },
    },
    {
      id: WORKBENCH_IDS.sshKey,
      name: "Prod/Orders via bastion",
      driver: "native_sshtun",
      hostIdentifier: "Mysql@10.0.0.5:3306@bastion.test:2222",
      parameters: {
        hostName: "10.0.0.5",
        port: 3306,
        userName: "orders",
        sshHost: "bastion.test:2222",
        sshUserName: "deploy",
        sshKeyFile: "/home/me/.ssh/id_ed25519",
        useSSL: 1,
      },
    },
    {
      id: WORKBENCH_IDS.sshPassword,
      name: "Prod/Billing via jump",
      driver: "native_sshtun",
      hostIdentifier: "Mysql@10.0.0.6:3306@jump.test",
      parameters: {
        hostName: "10.0.0.6",
        port: 3306,
        userName: "billing",
        sshHost: "jump.test",
        sshUserName: "ops",
        sshCompressionLevel: 6,
      },
    },
    {
      id: WORKBENCH_IDS.verifyCa,
      name: "Secure",
      driver: "native",
      hostIdentifier: "Mysql@secure.test:3306",
      parameters: {
        hostName: "secure.test",
        port: 3306,
        userName: "app",
        useSSL: 3,
        sslCA: "/certs/ca.pem",
        sslCert: "/certs/client.pem",
        sslKey: "/certs/client.key",
        sslCipher: "TLS_AES_256_GCM_SHA384",
      },
    },
    {
      id: WORKBENCH_IDS.ldap,
      name: "Directory",
      driver: "ldap_user_password",
      hostIdentifier: "Mysql@ldap.test:3306",
      parameters: { hostName: "ldap.test", port: 3306, userName: "alice" },
    },
    {
      id: WORKBENCH_IDS.kerberos,
      name: "Kerberos",
      driver: "ldap_kerberos",
      hostIdentifier: "Mysql@krb.test:3306",
      parameters: { hostName: "krb.test", port: 3306, userName: "bob" },
    },
    {
      id: WORKBENCH_IDS.noIdentifier,
      name: "Team/Reports/Daily",
      driver: "native",
      parameters: { hostName: "reports.test", port: 3307, userName: "reader" },
    },
  ];
}

/** A file from before Workbench 5.2: `host` and `username`, and the password in clear. */
export function legacyWorkbenchXml(): string {
  return workbenchXml([
    {
      id: "{0E5A9C4B-0000-4000-8000-000000000001}",
      name: "Old server",
      driver: "native",
      parameters: { host: "old.test", port: 3306, username: "legacy", password: "cleartext-secret", schema: "app" },
    },
  ]);
}

/** Workbench's user data directory under a fake home, per platform. */
export function workbenchDirectory(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "MySQL", "Workbench");
  if (platform === "win32") return join(home, "AppData", "Roaming", "MySQL", "Workbench");
  return join(home, ".mysql", "workbench");
}

/** Writes `connections.xml` where Workbench keeps it and answers its path. */
export function writeWorkbenchFixture(home: string, platform: NodeJS.Platform, xml: string): string {
  const directory = workbenchDirectory(home, platform);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "connections.xml");
  writeFileSync(path, xml);
  return path;
}
