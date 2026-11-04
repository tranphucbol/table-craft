import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BEEKEEPER_WRAPPER_KEY } from "@table-craft/desktop/main/import/beekeeperCrypto.js";

/** The per-install key the fixtures seal secrets with, as Beekeeper's `.key` holds it. */
export const BEEKEEPER_INSTALL_KEY = "4f2a9c7e1b3d5f6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a";

/** A value written as-is, past the sealing of secret columns. */
export interface RawValue {
  readonly raw: string;
}

export type BeekeeperValue = string | number | null | RawValue;
export type BeekeeperRow = Readonly<Record<string, BeekeeperValue>>;

export interface BeekeeperFolder {
  readonly id: number;
  readonly name: string;
  readonly parentId: number | null;
}

export interface BeekeeperFixture {
  readonly connections: readonly BeekeeperRow[];
  readonly folders?: readonly BeekeeperFolder[];
  /** The 2020 schema: no folders, workspaces, positions, sockets or read-only mode. */
  readonly legacy?: boolean;
  /** The `.key` text; null leaves it out, undefined writes the one for `BEEKEEPER_INSTALL_KEY`. */
  readonly keyFile?: string | null;
}

const SECRET_COLUMNS = new Set(["password", "sshPassword", "sshKeyfilePassword", "sshBastionPassword"]);

const LEGACY_COLUMNS = [
  "id integer PRIMARY KEY AUTOINCREMENT NOT NULL",
  "createdAt datetime NOT NULL DEFAULT (datetime('now'))",
  "updatedAt datetime NOT NULL DEFAULT (datetime('now'))",
  "version integer NOT NULL DEFAULT 1",
  "name varchar NOT NULL",
  "connectionType varchar",
  "host varchar",
  "port integer",
  "username varchar",
  "defaultDatabase varchar",
  "uri varchar",
  "uniqueHash varchar(500) NOT NULL DEFAULT 'DEPRECATED'",
  "path varchar",
  "sshEnabled boolean NOT NULL DEFAULT 0",
  "sshHost varchar",
  "sshPort integer",
  "sshKeyfile varchar",
  "sshUsername varchar",
  "sshMode varchar(8) NOT NULL DEFAULT 'keyfile'",
  "rememberPassword boolean NOT NULL DEFAULT 1",
  "rememberSshPassword boolean NOT NULL DEFAULT 0",
  "rememberSshKeyfilePassword boolean NOT NULL DEFAULT 0",
  "password varchar",
  "sshKeyfilePassword varchar",
  "sshPassword varchar",
  "ssl boolean NOT NULL DEFAULT 0",
  "labelColor varchar DEFAULT 'default'",
];

const CURRENT_COLUMNS = [
  ...LEGACY_COLUMNS.filter((column) => !column.startsWith("uri ")),
  "url varchar",
  "domain varchar",
  "socketPath varchar",
  "socketPathEnabled boolean NOT NULL DEFAULT 0",
  "sshBastionHost varchar",
  "sshBastionHostPort integer",
  "sshBastionMode varchar(8) NOT NULL DEFAULT 'agent'",
  "sshBastionUsername varchar",
  "sshBastionKeyfile varchar",
  "sshBastionPassword varchar",
  "sshKeepaliveInterval integer DEFAULT 60",
  "sslCaFile varchar",
  "sslCertFile varchar",
  "sslKeyFile varchar",
  "sslRejectUnauthorized boolean NOT NULL DEFAULT 1",
  "readOnlyMode boolean NOT NULL DEFAULT 0",
  "options text NOT NULL DEFAULT '{}'",
  "azureAuthOptions text",
  "iamAuthOptions text",
  "trustServerCertificate boolean NOT NULL DEFAULT 0",
  "windowsAuthEnabled boolean NOT NULL DEFAULT 0",
  "serviceName varchar",
  "workspaceId integer NOT NULL DEFAULT -1",
  "connectionFolderId integer",
  "position float NOT NULL DEFAULT 0",
];

const FOLDER_COLUMNS = [
  "id integer PRIMARY KEY AUTOINCREMENT NOT NULL",
  "name varchar(255) NOT NULL",
  "description varchar(255)",
  "expanded boolean DEFAULT 1",
  "parentId integer",
  "createdAt datetime NOT NULL DEFAULT (datetime('now'))",
  "updatedAt datetime NOT NULL DEFAULT (datetime('now'))",
  "version integer NOT NULL DEFAULT 1",
];

/** Seals a value the way `simple-encryptor` 3 does, for the reader to open. */
export function sealForBeekeeper(key: string, value: unknown): string {
  const cryptoKey = createHash("sha256").update(key).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", cryptoKey, iv);
  const body = iv.toString("hex") + cipher.update(JSON.stringify(value), "utf8", "base64") + cipher.final("base64");
  return createHmac("sha256", cryptoKey).update(body).digest("hex") + body;
}

/** The text of a `.key` that opens to `key`. */
export function beekeeperKeyFile(key: string = BEEKEEPER_INSTALL_KEY): string {
  return sealForBeekeeper(BEEKEEPER_WRAPPER_KEY, { encryptionKey: key });
}

/** Beekeeper's userData folder under a fake home, per platform, as a packaged install names it. */
export function beekeeperDirectory(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "beekeeper-studio");
  if (platform === "win32") return join(home, "AppData", "Roaming", "beekeeper-studio");
  return join(home, ".config", "beekeeper-studio");
}

function stored(column: string, value: BeekeeperValue): string | number | null {
  if (value === null || typeof value === "number") return value;
  if (typeof value === "object") return value.raw;
  return SECRET_COLUMNS.has(column) ? sealForBeekeeper(BEEKEEPER_INSTALL_KEY, value) : value;
}

/** Writes an `app.db` at `path` with the fixture's connections and folders. */
export function writeBeekeeperDatabase(path: string, fixture: BeekeeperFixture): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE saved_connection (${(fixture.legacy === true ? LEGACY_COLUMNS : CURRENT_COLUMNS).join(", ")})`,
    );
    database.exec("CREATE TABLE used_connection (id integer PRIMARY KEY, name varchar, host varchar)");
    database.exec("INSERT INTO used_connection (name, host) VALUES ('Recently used', 'recent.test')");
    if (fixture.legacy !== true) {
      database.exec(`CREATE TABLE connection_folder (${FOLDER_COLUMNS.join(", ")})`);
      for (const folder of fixture.folders ?? []) {
        database
          .prepare("INSERT INTO connection_folder (id, name, parentId) VALUES (?, ?, ?)")
          .run(folder.id, folder.name, folder.parentId);
      }
    }
    for (const row of fixture.connections) {
      const columns = Object.keys(row);
      const placeholders = columns.map(() => "?").join(", ");
      database
        .prepare(`INSERT INTO saved_connection (${columns.join(", ")}) VALUES (${placeholders})`)
        .run(...columns.map((column) => stored(column, row[column] ?? null)));
    }
  } finally {
    database.close();
  }
}

/** Writes `app.db` and `.key` where Beekeeper keeps them and answers the database's path. */
export function writeBeekeeperFixture(home: string, platform: NodeJS.Platform, fixture: BeekeeperFixture): string {
  const directory = beekeeperDirectory(home, platform);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "app.db");
  writeBeekeeperDatabase(path, fixture);
  const keyFile = fixture.keyFile === undefined ? beekeeperKeyFile() : fixture.keyFile;
  if (keyFile !== null) writeFileSync(join(directory, ".key"), keyFile);
  return path;
}

export interface BeekeeperServers {
  readonly mysql: { readonly host: string; readonly port: number };
  readonly postgres: { readonly host: string; readonly port: number };
}

/** A spread of saved connections: each sign-in, tunnel, TLS setting and unsupported shape the reader handles. */
export function beekeeperConnections(servers: BeekeeperServers, sqlitePath: string): BeekeeperRow[] {
  return [
    {
      id: 1,
      createdAt: "2026-01-05 10:00:00",
      name: "Shop MySQL",
      connectionType: "mysql",
      host: servers.mysql.host,
      port: servers.mysql.port,
      username: "shop",
      defaultDatabase: "shop",
      password: "mysql-secret",
      labelColor: "pink",
      connectionFolderId: 2,
      position: 1,
    },
    {
      id: 2,
      createdAt: "2026-01-05 10:01:00",
      name: "Reporting",
      connectionType: "psql",
      host: servers.postgres.host,
      port: servers.postgres.port,
      username: "reporter",
      defaultDatabase: "reports",
      password: "pg-secret",
      ssl: 1,
      readOnlyMode: 1,
      connectionFolderId: 1,
    },
    {
      id: 3,
      createdAt: "2026-01-05 10:02:00",
      name: "Local file",
      connectionType: "sqlite",
      defaultDatabase: sqlitePath,
      labelColor: "default",
    },
    {
      id: 4,
      createdAt: "2026-01-05 10:03:00",
      name: "Through bastion",
      connectionType: "mysql",
      host: "10.0.0.5",
      port: 3306,
      username: "app",
      password: "tunnel-db-secret",
      sshEnabled: 1,
      sshHost: "bastion.test",
      sshPort: 2222,
      sshUsername: "deploy",
      sshMode: "userpass",
      sshPassword: "ssh-secret",
    },
    {
      id: 5,
      createdAt: "2026-01-05 10:04:00",
      name: "Key tunnel",
      connectionType: "mysql",
      host: "10.0.0.6",
      port: 3306,
      username: "app",
      sshEnabled: 1,
      sshHost: "jump.test",
      sshUsername: "deploy",
      sshMode: "keyfile",
      sshKeyfile: "/keys/deploy",
      sshKeyfilePassword: "key-passphrase",
    },
    {
      id: 6,
      createdAt: "2026-01-05 10:05:00",
      name: "Socket",
      connectionType: "mysql",
      socketPathEnabled: 1,
      socketPath: "/tmp/mysql.sock",
      username: "root",
    },
    {
      id: 7,
      createdAt: "2026-01-05 10:06:00",
      name: "Cloud only",
      connectionType: "mysql",
      host: "cloud.test",
      workspaceId: 12,
    },
    {
      id: 8,
      createdAt: "2026-01-05 10:07:00",
      name: "Mongo",
      connectionType: "mongodb",
      host: "mongo.test",
      port: 27017,
    },
  ];
}

/** Folders `Production` and its child `Production/EU`, plus an empty `Archive`. */
export const BEEKEEPER_FOLDERS: readonly BeekeeperFolder[] = [
  { id: 1, name: "Production", parentId: null },
  { id: 2, name: "EU", parentId: 1 },
  { id: 3, name: "Archive", parentId: null },
];
