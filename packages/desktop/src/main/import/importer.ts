import { basename } from "node:path";
import type { Logger } from "@table-craft/desktop/log/record.js";
import {
  readDataGripFile,
  scanDataGrip,
  type DataGripPasswordStore,
} from "@table-craft/desktop/main/import/datagrip.js";
import { KdbxError, readKdbx, readMainKey } from "@table-craft/desktop/main/import/kdbx.js";
import type { CredentialReader } from "@table-craft/desktop/main/import/keychain.js";
import {
  TOP_FOLDERS,
  freeName,
  importFolder,
  mapConnection,
  type MappedConnection,
  type PasswordAvailability,
} from "@table-craft/desktop/main/import/mapping.js";
import {
  TableProBundleError,
  readTableProBundle,
  scanTablePro,
  type TableProGroup,
} from "@table-craft/desktop/main/import/tablepro.js";
import type {
  ForeignApp,
  ForeignConnection,
  ImportEnvironment,
  PasswordSource,
} from "@table-craft/desktop/main/import/types.js";
import {
  WORKBENCH_CONNECTIONS_FILE,
  isWorkbenchXml,
  readWorkbenchXml,
  scanWorkbench,
} from "@table-craft/desktop/main/import/workbench.js";
import { XmlError } from "@table-craft/desktop/main/import/xml.js";
import { ZipReadError, readZipEntry } from "@table-craft/desktop/main/import/zipReader.js";
import { DatasourceError, type DatasourceService, type ImportedDatasource } from "@table-craft/desktop/main/service.js";
import {
  SSH_SECRET_KEYS,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportProgress,
  type ImportRunRequest,
  type ImportSource,
  type ImportSummary,
} from "@table-craft/desktop/preload/bridge.js";

const XML_FILE_EXTENSION = ".xml";
const ZIP_FILE_EXTENSION = ".zip";
/** Far above any real `connections.xml`; a bigger entry is not one. */
const MAX_WORKBENCH_FILE_BYTES = 16 * 1024 * 1024;
const PICK_WORKBENCH_FILE = "Pick Workbench's connections.xml or a Backup Connections .zip.";
const LABELS: Readonly<Record<ForeignApp, string>> = {
  datagrip: "DataGrip",
  tablepro: "TablePro",
  workbench: "MySQL Workbench",
};

export interface ImporterOptions {
  readonly environment: ImportEnvironment;
  readonly credentials: CredentialReader;
  /** TablePro's folders, from its preferences; empty when none or unreadable. */
  readonly tableProGroups: () => Promise<readonly TableProGroup[]>;
  readonly service: Pick<DatasourceService<unknown>, "list" | "plugins" | "importMany">;
  /** The `import` logger: counts and outcomes only, never a name, host or secret. */
  readonly log: Pick<Logger, "info" | "warn">;
}

export interface Importer {
  scan(): Promise<ImportSource[]>;
  preview(request: ImportPreviewRequest): Promise<ImportPreview>;
  run(request: ImportRunRequest, progress: (progress: ImportProgress) => void): Promise<ImportSummary>;
  cancel(): void;
}

/** KeePass entries by title, or why the file could not be opened. */
type KeePassRead = { readonly passwords: ReadonlyMap<string, string> } | { readonly locked: string } | null;

interface Entry {
  readonly connection: ForeignConnection;
  readonly mapped: MappedConnection;
}

interface Preview {
  readonly id: number;
  readonly entries: ReadonlyMap<string, Entry>;
  readonly keePass: KeePassRead;
}

function storeLabel(store: DataGripPasswordStore, credentials: CredentialReader): string {
  if (store.kind === "keepass") return "KeePass (c.kdbx)";
  if (store.kind === "memory") return "Not saved";
  return credentials.available ? credentials.label : `${credentials.label}, which TableCraft cannot read yet`;
}

/**
 * Scans, previews and imports another app's connections (plan 035). Everything it reads stays in
 * main: the renderer gets rows with a password state, never a value (decision 020).
 */
export function createImporter(options: ImporterOptions): Importer {
  const { environment, credentials, service, log } = options;
  let previewCount = 0;
  let current: Preview | null = null;
  let cancelled = false;

  async function readKeePass(store: DataGripPasswordStore): Promise<KeePassRead> {
    if (store.kind !== "keepass") return null;
    const database = await environment.files.readBytes(store.database);
    if (database === null) return { passwords: new Map() };
    let mainKeyText: string | null = null;
    for (const path of store.mainKey) {
      mainKeyText = await environment.files.readText(path);
      if (mainKeyText !== null) break;
    }
    if (mainKeyText === null) return { locked: "KeePass is protected by a main password TableCraft does not have." };
    try {
      const passwords = new Map<string, string>();
      for (const entry of readKdbx(database, readMainKey(mainKeyText))) {
        if (entry.password !== null && !passwords.has(entry.title)) passwords.set(entry.title, entry.password);
      }
      return { passwords };
    } catch (cause) {
      // Connections import without their passwords rather than not at all.
      const known = cause instanceof KdbxError;
      log.warn("keepass unreadable", { problem: known ? cause.problem : "unexpected" });
      return { locked: known ? cause.message : "TableCraft could not read DataGrip's KeePass database." };
    }
  }

  function availabilityFor(store: DataGripPasswordStore | null, keePass: KeePassRead) {
    return (connection: ForeignConnection): PasswordAvailability => {
      const { password } = connection;
      if (password.kind === "none") return "none";
      if (password.kind === "bundle") return "inFile";
      if (password.kind === "elsewhere") return "elsewhere";
      if (store?.kind === "memory") return "none";
      if (keePass !== null) {
        if ("locked" in keePass) return "locked";
        return keePass.passwords.has(password.service) ? "found" : "none";
      }
      return credentials.available ? "store" : "locked";
    };
  }

  function remember(
    app: ForeignApp,
    connections: readonly ForeignConnection[],
    store: DataGripPasswordStore | null,
    keePass: KeePassRead,
  ): ImportPreview {
    const { datasources } = service.list();
    const context = {
      plugins: service.plugins(),
      existing: datasources.filter((datasource) => !datasource.ephemeral),
      availability: availabilityFor(store, keePass),
    };
    const entries = new Map<string, Entry>();
    for (const connection of connections) {
      const mapped = mapConnection(connection, context);
      if (!entries.has(mapped.row.key)) entries.set(mapped.row.key, { connection, mapped });
    }
    previewCount += 1;
    current = { id: previewCount, entries, keePass };
    const rows = [...entries.values()].map((entry) => entry.mapped.row);
    log.info("import preview", {
      app,
      found: rows.length,
      importable: rows.filter((row) => row.status !== "unsupported").length,
      unsupported: rows.filter((row) => row.status === "unsupported").length,
    });
    return { status: "ready", previewId: current.id, app, topFolder: TOP_FOLDERS[app], rows };
  }

  function previewWorkbench(text: string, name: string): ImportPreview {
    let connections: ForeignConnection[];
    try {
      connections = readWorkbenchXml(text, environment.platform);
    } catch (cause) {
      if (!(cause instanceof XmlError)) throw cause;
      throw new DatasourceError(`${name} is not a MySQL Workbench connections file.`, PICK_WORKBENCH_FILE);
    }
    if (connections.length === 0) {
      throw new DatasourceError(`${name} holds no MySQL Workbench connections.`, PICK_WORKBENCH_FILE);
    }
    return remember("workbench", connections, null, null);
  }

  async function previewZip(path: string): Promise<ImportPreview> {
    const bytes = await environment.files.readBytes(path);
    if (bytes === null)
      throw new DatasourceError(`${basename(path)} could not be read.`, "Check the file still exists.");
    let entry: Uint8Array | null;
    try {
      entry = readZipEntry(bytes, WORKBENCH_CONNECTIONS_FILE, MAX_WORKBENCH_FILE_BYTES);
    } catch (cause) {
      if (!(cause instanceof ZipReadError)) throw cause;
      throw new DatasourceError(`${basename(path)}: ${cause.message}`, PICK_WORKBENCH_FILE);
    }
    if (entry === null) {
      throw new DatasourceError(`${basename(path)} holds no ${WORKBENCH_CONNECTIONS_FILE}.`, PICK_WORKBENCH_FILE);
    }
    return previewWorkbench(new TextDecoder().decode(entry), basename(path));
  }

  async function previewFile(path: string, passphrase: string | undefined): Promise<ImportPreview> {
    const extension = path.toLowerCase();
    if (extension.endsWith(ZIP_FILE_EXTENSION)) return previewZip(path);
    if (extension.endsWith(XML_FILE_EXTENSION)) {
      const text = await environment.files.readText(path);
      if (text !== null && isWorkbenchXml(text)) return previewWorkbench(text, basename(path));
      const { passwordStore } = await scanDataGrip(environment);
      const connections = await readDataGripFile(environment, path);
      if (connections.length === 0) {
        throw new DatasourceError(
          `${basename(path)} holds no DataGrip data sources.`,
          "Pick a project's .idea/dataSources.xml.",
        );
      }
      return remember("datagrip", connections, passwordStore, await readKeePass(passwordStore));
    }
    const bytes = await environment.files.readBytes(path);
    if (bytes === null)
      throw new DatasourceError(`${basename(path)} could not be read.`, "Check the file still exists.");
    try {
      return remember("tablepro", await readTableProBundle(bytes, passphrase ?? null, basename(path)), null, null);
    } catch (cause) {
      if (!(cause instanceof TableProBundleError)) throw cause;
      if (cause.problem === "unreadable") throw new DatasourceError(cause.message, "Pick a file TablePro exported.");
      return { status: cause.problem, message: cause.message };
    }
  }

  return {
    async scan() {
      const dataGrip = await scanDataGrip(environment);
      const tablePro = await scanTablePro(environment, await options.tableProGroups());
      const workbench = await scanWorkbench(environment);
      log.info("import scan", {
        datagrip: dataGrip.connections.length,
        datagripProjects: dataGrip.projects,
        tablepro: tablePro.connections.length,
        workbench: workbench.connections.length,
      });
      return [
        {
          app: "datagrip",
          label: LABELS.datagrip,
          found: dataGrip.configDir !== null,
          count: dataGrip.connections.length,
          locations: dataGrip.configDir === null ? dataGrip.looked : [dataGrip.configDir],
          passwords: storeLabel(dataGrip.passwordStore, credentials),
        },
        {
          app: "tablepro",
          label: LABELS.tablepro,
          found: tablePro.found,
          count: tablePro.connections.length,
          locations: tablePro.path === null ? [] : [tablePro.path],
          passwords: "In TablePro's keychain; export an encrypted .tablepro file to bring them",
        },
        {
          app: "workbench",
          label: LABELS.workbench,
          found: workbench.found,
          count: workbench.connections.length,
          locations: workbench.path === null ? workbench.looked : [workbench.path],
          passwords: credentials.available
            ? credentials.label
            : "In Workbench's encrypted vault, which TableCraft cannot read; asked for on connect",
        },
      ];
    },
    async preview(request) {
      if (request.source === "file") return previewFile(request.path, request.passphrase);
      if (request.source === "datagrip") {
        const scan = await scanDataGrip(environment);
        return remember("datagrip", scan.connections, scan.passwordStore, await readKeePass(scan.passwordStore));
      }
      if (request.source === "workbench")
        return remember("workbench", (await scanWorkbench(environment)).connections, null, null);
      const scan = await scanTablePro(environment, await options.tableProGroups());
      return remember("tablepro", scan.connections, null, null);
    },
    async run(request, progress) {
      const preview = current;
      if (preview?.id !== request.previewId) {
        throw new DatasourceError("The import preview is out of date.", "Go back and choose the source again.");
      }
      cancelled = false;
      const chosen = request.keys
        .map((key) => preview.entries.get(key))
        .filter((entry): entry is Entry => entry !== undefined && entry.mapped.draft !== null);
      const taken = service.list().datasources.map(({ name, folder }) => ({ name, folder }));
      const items: ImportedDatasource[] = [];
      let withPasswords = 0;
      let keychainDenied = false;
      for (const [index, entry] of chosen.entries()) {
        if (cancelled) break;
        const { connection, mapped } = entry;
        const draft = mapped.draft;
        if (draft === null) continue;
        const read = async (source: PasswordSource): Promise<string | null> => {
          if (source.kind === "bundle") return source.value;
          if (source.kind !== "store") return null;
          if (preview.keePass !== null) {
            return "passwords" in preview.keePass ? (preview.keePass.passwords.get(source.service) ?? null) : null;
          }
          if (!credentials.available || keychainDenied) return null;
          progress({
            done: index,
            total: chosen.length,
            message: `Reading ${credentials.label} ${String(index + 1)} of ${String(chosen.length)}… the system may ask; click Allow.`,
          });
          const found = await credentials.lookup(source.service, source.account);
          if (found.status === "denied") keychainDenied = true;
          return found.status === "found" ? found.value : null;
        };
        const password =
          request.importPasswords && mapped.passwordKey !== null ? await read(connection.password) : null;
        const sshPassword =
          request.importPasswords && draft.ssh?.auth === "password" && connection.ssh !== null
            ? await read(connection.ssh.password)
            : null;
        const folder = importFolder(connection.app, draft.folder, request.topFolder);
        const name = freeName(draft.name, folder, taken);
        taken.push({ name, folder });
        const secrets: Record<string, string> = {};
        if (password !== null && mapped.passwordKey !== null) {
          secrets[mapped.passwordKey] = password;
          withPasswords += 1;
        }
        if (sshPassword !== null) secrets[SSH_SECRET_KEYS.password] = sshPassword;
        items.push({ draft: { ...draft, name, folder }, secrets });
        progress({
          done: index + 1,
          total: chosen.length,
          message: `Imported ${String(index + 1)} of ${String(chosen.length)}`,
        });
      }
      const ids = await service.importMany(items);
      const summary: ImportSummary = {
        imported: ids.length,
        withPasswords,
        skipped: request.keys.length - ids.length,
        ids,
        cancelled,
        keychainDenied,
      };
      log.info("import done", {
        imported: summary.imported,
        withPasswords,
        skipped: summary.skipped,
        cancelled,
        keychainDenied,
      });
      return summary;
    },
    cancel() {
      cancelled = true;
    },
  };
}
