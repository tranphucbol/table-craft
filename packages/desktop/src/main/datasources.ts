import { join } from "node:path";
import { BRAND_ID, z } from "@table-craft/plugin-api";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";
import {
  DATASOURCE_COLORS,
  IMPORT_APPS,
  SECRET_MODES,
  SSH_SECRET_KEYS,
  type ConnectionField,
  type Datasource,
  type DatasourceDraft,
} from "@table-craft/desktop/preload/bridge.js";
import { AGENT_ACCESS_LEVELS } from "@table-craft/desktop/settings/mcp.js";
import {
  KEEPALIVE_SECONDS_RANGE,
  MCP_ROW_CAP_RANGE,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
} from "@table-craft/desktop/settings/settings.js";

export const DATASOURCES_FILE = "datasources.json";
/** Bumped with a migration in `migrate` whenever the file's shape changes (decision 010). */
export const DATASOURCES_VERSION = 1;
const BACKUP_SUFFIX = ".corrupt-";
const FOLDER_SEPARATOR = "/";
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
}) satisfies z.ZodType<Datasource>;

/** What the dialog sends; main assigns the id of a new one. */
export const draftSchema = datasourceSchema.extend({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, { message: "Give the data source a name." }),
  folder: z.string().nullable(),
}) satisfies z.ZodType<DatasourceDraft>;

const fileSchema = z.strictObject({
  version: z.literal(DATASOURCES_VERSION),
  datasources: z.array(datasourceSchema),
});

export interface LoadedDatasources {
  readonly datasources: readonly Datasource[];
  /** Why the file was set aside, for the one-time warning; null when it read cleanly. */
  readonly warning: string | null;
}

export interface DatasourceStore {
  load(): Promise<LoadedDatasources>;
  save(datasources: readonly Datasource[]): Promise<void>;
}

export interface DatasourceStoreOptions {
  readonly directory: string;
  readonly files: FileSystem;
  readonly now?: () => number;
}

/**
 * Each older version's upgrade to the next, keyed by the version it reads. Empty while version 1
 * is the only one; a file from a newer TableCraft fails validation and is set aside.
 */
const MIGRATIONS: ReadonlyMap<number, (file: Record<string, unknown>) => Record<string, unknown>> = new Map();

function migrate(json: unknown): unknown {
  let file = json as Record<string, unknown> | null;
  while (typeof file?.version === "number" && MIGRATIONS.has(file.version)) {
    file = MIGRATIONS.get(file.version)?.(file) ?? file;
  }
  return file;
}

/** `/`-separated, trimmed, without empty segments; null for the top level. */
export function normalizeFolder(folder: string | null): string | null {
  const segments = (folder ?? "")
    .split(FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  return segments.length === 0 ? null : segments.join(FOLDER_SEPARATOR);
}

/**
 * Drops config keys the form does not declare and every secret value, whatever the renderer sent,
 * and the SSH tunnel unless the plugin `offersTunnel` (its manifest declares `network`, decision 070).
 */
export function toDatasource(
  draft: DatasourceDraft,
  id: string,
  fields: readonly ConnectionField[],
  offersTunnel = false,
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
  };
}

export function createDatasourceStore(options: DatasourceStoreOptions): DatasourceStore {
  const path = join(options.directory, DATASOURCES_FILE);
  const now = options.now ?? Date.now;

  async function setAside(reason: string): Promise<LoadedDatasources> {
    const backup = `${path}${BACKUP_SUFFIX}${String(now())}`;
    await options.files.rename(path, backup);
    return {
      datasources: [],
      warning: `${DATASOURCES_FILE} could not be read (${reason}). It was moved to ${backup}, and the data source list starts empty.`,
    };
  }

  return {
    async load() {
      const text = await options.files.readText(path);
      if (text === null) return { datasources: [], warning: null };
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
      return { datasources: parsed.data.datasources, warning: null };
    },
    async save(datasources) {
      const file = { version: DATASOURCES_VERSION, datasources };
      await writeAtomically(options.files, path, `${JSON.stringify(file, null, JSON_INDENT)}\n`);
    },
  };
}
