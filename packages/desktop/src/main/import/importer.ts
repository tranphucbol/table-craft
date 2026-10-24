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
import type { ForeignApp, ForeignConnection, ImportEnvironment } from "@table-craft/desktop/main/import/types.js";
import { DatasourceError, type DatasourceService, type ImportedDatasource } from "@table-craft/desktop/main/service.js";
import type {
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportRunRequest,
  ImportSource,
  ImportSummary,
} from "@table-craft/desktop/preload/bridge.js";

const DATAGRIP_FILE_EXTENSION = ".xml";
const LABELS: Readonly<Record<ForeignApp, string>> = { datagrip: "DataGrip", tablepro: "TablePro" };

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
      if (!(cause instanceof KdbxError)) throw cause;
      log.warn("keepass unreadable", { problem: cause.problem });
      return { locked: cause.message };
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

  async function previewFile(path: string, passphrase: string | undefined): Promise<ImportPreview> {
    if (path.toLowerCase().endsWith(DATAGRIP_FILE_EXTENSION)) {
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
      log.info("import scan", {
        datagrip: dataGrip.connections.length,
        datagripProjects: dataGrip.projects,
        tablepro: tablePro.connections.length,
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
          locations: [tablePro.path],
          passwords: "In TablePro's keychain; export an encrypted .tablepro file to bring them",
        },
      ];
    },
    async preview(request) {
      if (request.source === "file") return previewFile(request.path, request.passphrase);
      if (request.source === "datagrip") {
        const scan = await scanDataGrip(environment);
        return remember("datagrip", scan.connections, scan.passwordStore, await readKeePass(scan.passwordStore));
      }
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
        let password: string | null = null;
        const source = connection.password;
        if (request.importPasswords && mapped.passwordKey !== null) {
          if (source.kind === "bundle") password = source.value;
          else if (source.kind === "store" && preview.keePass !== null && "passwords" in preview.keePass) {
            password = preview.keePass.passwords.get(source.service) ?? null;
          } else if (source.kind === "store" && preview.keePass === null && credentials.available && !keychainDenied) {
            progress({
              done: index,
              total: chosen.length,
              message: `Reading ${credentials.label} ${String(index + 1)} of ${String(chosen.length)}… the system may ask; click Allow.`,
            });
            const found = await credentials.lookup(source.service);
            if (found.status === "found") password = found.value;
            if (found.status === "denied") keychainDenied = true;
          }
        }
        const folder = importFolder(connection.app, draft.folder, request.topFolder);
        const name = freeName(draft.name, folder, taken);
        taken.push({ name, folder });
        const secrets: Record<string, string> = {};
        if (password !== null && mapped.passwordKey !== null) {
          secrets[mapped.passwordKey] = password;
          withPasswords += 1;
        }
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
