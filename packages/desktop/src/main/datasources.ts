import { join } from "node:path";
import { BRAND_ID, z } from "@table-craft/plugin-api";
import {
  compareFolderPaths,
  NAME_ORDER,
  normalizeFolder,
  normalizeFolders,
} from "@table-craft/desktop/datasourceTree/arrange.js";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";
import {
  DATASOURCE_COLORS,
  IMPORT_APPS,
  SECRET_MODES,
  SSH_SECRET_KEYS,
  type ConnectionField,
  type Datasource,
  type DatasourceDraft,
  type LastServer,
  type ServerSeen,
} from "@table-craft/desktop/preload/bridge.js";
import { AGENT_ACCESS_LEVELS } from "@table-craft/desktop/settings/mcp.js";
import {
  KEEPALIVE_SECONDS_RANGE,
  MCP_ROW_CAP_RANGE,
  MCP_TIMEOUT_SECONDS_RANGE,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
} from "@table-craft/desktop/settings/settings.js";

export const DATASOURCES_FILE = "datasources.json";
/** Bumped with a migration in `migrate` whenever the file's shape changes (decision 010). */
export const DATASOURCES_VERSION = 2;
const BACKUP_SUFFIX = ".corrupt-";
const JSON_INDENT = 2;

const configValue = z.union([z.string(), z.number(), z.boolean()]);
const MAX_PORT = 65_535;

const sshSchema = z.strictObject({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number().int().min(1).max(MAX_PORT),
  user: z.string(),
  auth: z.enum(["password", "key", "agent"]),
  keyPath: z.string(),
});

export const lastServerSchema = z.strictObject({
  version: z.string().nullable(),
  timeout: z
    .strictObject({
      setting: z.string().min(1),
      covers: z.enum(["reads", "all"]),
      counts: z.enum(["statement", "serverWork"]),
    })
    .nullable()
    .optional(),
  cancel: z
    .strictObject({ method: z.string().min(1), reaches: z.enum(["statement", "connection", "blockingCommands"]) })
    .optional(),
  seenAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<LastServer>;

/** What a connection reported, as `rememberServer` takes it from a window or the MCP host. */
export const serverSeenSchema = z.strictObject({
  brand: z.string().regex(BRAND_ID).nullable(),
  lastServer: lastServerSchema,
}) satisfies z.ZodType<ServerSeen>;

const datasourceSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  pluginId: z.string().min(1),
  folder: z.string().min(1).nullable(),
  color: z.enum(DATASOURCE_COLORS).nullable(),
  readOnly: z.boolean(),
  keepAliveSeconds: z.number().int().min(KEEPALIVE_SECONDS_RANGE.min).max(KEEPALIVE_SECONDS_RANGE.max).optional(),
  statementTimeoutSeconds: z
    .number()
    .int()
    .min(STATEMENT_TIMEOUT_SECONDS_RANGE.min)
    .max(STATEMENT_TIMEOUT_SECONDS_RANGE.max)
    .optional(),
  enforceTimeoutOnServer: z.literal(true).optional(),
  loadKeysOnDemand: z.literal(true).optional(),
  comment: z.string(),
  config: z.record(z.string(), configValue),
  secretModes: z.record(z.string(), z.enum(SECRET_MODES)),
  origin: z.strictObject({ app: z.enum(IMPORT_APPS), id: z.string().min(1) }).optional(),
  ssh: sshSchema.optional(),
  shownNamespaces: z.array(z.string()).readonly().optional(),
  agentAccess: z.enum(AGENT_ACCESS_LEVELS).optional(),
  agentSchemas: z.array(z.string()).readonly().optional(),
  agentRowCap: z.number().int().min(MCP_ROW_CAP_RANGE.min).max(MCP_ROW_CAP_RANGE.max).optional(),
  brand: z.string().regex(BRAND_ID).optional(),
  agentTimeoutSeconds: z
    .number()
    .int()
    .min(MCP_TIMEOUT_SECONDS_RANGE.min)
    .max(MCP_TIMEOUT_SECONDS_RANGE.max)
    .optional(),
  lastServer: lastServerSchema.optional(),
}) satisfies z.ZodType<Datasource>;

/** What the dialog sends; main assigns the id of a new one. */
export const draftSchema = datasourceSchema.extend({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, { message: "Give the data source a name." }),
  folder: z.string().nullable(),
}) satisfies z.ZodType<DatasourceDraft>;

const fileSchema = z.strictObject({
  version: z.literal(DATASOURCES_VERSION),
  /** Every folder path, empty ones included, in the order the tree shows siblings (decision 145). */
  folders: z.array(z.string().min(1)),
  datasources: z.array(datasourceSchema),
});

/** The list as it is kept: the tree shows both arrays in their order. */
export interface StoredDatasources {
  readonly folders: readonly string[];
  readonly datasources: readonly Datasource[];
}

export interface LoadedDatasources extends StoredDatasources {
  /** Why the file was set aside, for the one-time warning; null when it read cleanly. */
  readonly warning: string | null;
}

export interface DatasourceStore {
  load(): Promise<LoadedDatasources>;
  save(stored: StoredDatasources): Promise<void>;
}

export interface DatasourceStoreOptions {
  readonly directory: string;
  readonly files: FileSystem;
  readonly now?: () => number;
}

type Migration = (file: Record<string, unknown>) => Record<string, unknown>;

/**
 * Version 1 had no stored order and the tree sorted every level by name, so version 2 starts from
 * that order and nobody's tree moves on upgrade (decision 145).
 */
const toVersion2: Migration = (file) => {
  const listed = Array.isArray(file.datasources) ? (file.datasources as unknown[]) : [];
  const nameOf = (entry: unknown) =>
    typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string"
      ? (entry as { name: string }).name
      : "";
  const folderOf = (entry: unknown) =>
    typeof entry === "object" && entry !== null && typeof (entry as { folder?: unknown }).folder === "string"
      ? (entry as { folder: string }).folder
      : null;
  const datasources = [...listed].sort((a, b) => NAME_ORDER.compare(nameOf(a), nameOf(b)));
  const folders = normalizeFolders(
    [],
    datasources.map((entry) => ({ folder: folderOf(entry) })),
  ).sort(compareFolderPaths);
  return { ...file, version: 2, folders, datasources };
};

/**
 * Each older version's upgrade to the next, keyed by the version it reads; a file from a newer
 * TableCraft fails validation and is set aside.
 */
const MIGRATIONS: ReadonlyMap<number, Migration> = new Map([[1, toVersion2]]);

function migrate(json: unknown): unknown {
  let file = json as Record<string, unknown> | null;
  while (typeof file?.version === "number" && MIGRATIONS.has(file.version)) {
    file = MIGRATIONS.get(file.version)?.(file) ?? file;
  }
  return file;
}

/**
 * Drops config keys the form does not declare and every secret value, whatever the renderer sent,
 * and the SSH tunnel unless the plugin `offersTunnel` (its manifest declares `network`, decision 070).
 * `lastServer` comes from `previous`, never the draft: only a connection says what the server is
 * (decision 131).
 */
export function toDatasource(
  draft: DatasourceDraft,
  id: string,
  fields: readonly ConnectionField[],
  offersTunnel = false,
  previous?: Pick<Datasource, "lastServer">,
): Datasource {
  const config: Record<string, Datasource["config"][string]> = {};
  const secretModes: Record<string, Datasource["secretModes"][string]> = {};
  for (const field of fields) {
    if (field.secret === true) {
      const mode = draft.secretModes[field.key];
      if (mode !== undefined) secretModes[field.key] = mode;
      continue;
    }
    const value = draft.config[field.key];
    if (value !== undefined) config[field.key] = value;
  }
  const ssh = offersTunnel ? draft.ssh : undefined;
  if (ssh !== undefined) {
    for (const key of Object.values(SSH_SECRET_KEYS)) {
      const mode = draft.secretModes[key];
      if (mode !== undefined) secretModes[key] = mode;
    }
  }
  return {
    id,
    name: draft.name.trim(),
    pluginId: draft.pluginId,
    folder: normalizeFolder(draft.folder),
    color: draft.color,
    readOnly: draft.readOnly,
    ...(draft.keepAliveSeconds === undefined ? {} : { keepAliveSeconds: draft.keepAliveSeconds }),
    ...(draft.statementTimeoutSeconds === undefined ? {} : { statementTimeoutSeconds: draft.statementTimeoutSeconds }),
    ...(draft.enforceTimeoutOnServer === true ? { enforceTimeoutOnServer: true } : {}),
    ...(draft.loadKeysOnDemand === true ? { loadKeysOnDemand: true } : {}),
    comment: draft.comment,
    config,
    secretModes,
    ...(draft.origin === undefined ? {} : { origin: { app: draft.origin.app, id: draft.origin.id } }),
    ...(ssh === undefined ? {} : { ssh: { ...ssh, host: ssh.host.trim(), user: ssh.user.trim() } }),
    ...(draft.shownNamespaces === undefined ? {} : { shownNamespaces: [...draft.shownNamespaces] }),
    ...(draft.agentAccess === undefined || draft.agentAccess === "off" ? {} : { agentAccess: draft.agentAccess }),
    ...(draft.agentSchemas === undefined ? {} : { agentSchemas: [...draft.agentSchemas] }),
    ...(draft.agentRowCap === undefined ? {} : { agentRowCap: draft.agentRowCap }),
    ...(draft.brand === undefined ? {} : { brand: draft.brand }),
    ...(draft.agentTimeoutSeconds === undefined ? {} : { agentTimeoutSeconds: draft.agentTimeoutSeconds }),
    ...(previous?.lastServer === undefined ? {} : { lastServer: previous.lastServer }),
  };
}

export function createDatasourceStore(options: DatasourceStoreOptions): DatasourceStore {
  const path = join(options.directory, DATASOURCES_FILE);
  const now = options.now ?? Date.now;

  async function setAside(reason: string): Promise<LoadedDatasources> {
    const backup = `${path}${BACKUP_SUFFIX}${String(now())}`;
    await options.files.rename(path, backup);
    return {
      folders: [],
      datasources: [],
      warning: `${DATASOURCES_FILE} could not be read (${reason}). It was moved to ${backup}, and the data source list starts empty.`,
    };
  }

  return {
    async load() {
      const text = await options.files.readText(path);
      if (text === null) return { folders: [], datasources: [], warning: null };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        return setAside(`not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const parsed = fileSchema.safeParse(migrate(json));
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
        return setAside(issues.join("; "));
      }
      const { datasources } = parsed.data;
      return { folders: normalizeFolders(parsed.data.folders, datasources), datasources, warning: null };
    },
    async save({ folders, datasources }) {
      const file = { version: DATASOURCES_VERSION, folders, datasources };
      await writeAtomically(options.files, path, `${JSON.stringify(file, null, JSON_INDENT)}\n`);
    },
  };
}
