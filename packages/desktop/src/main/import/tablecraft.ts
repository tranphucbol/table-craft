import { normalizeFolder } from "@table-craft/desktop/datasourceTree/arrange.js";
import type { DatasourceSecrets, ExportedDatasource, ReadRecord } from "@table-craft/desktop/main/datasourceFile.js";
import { comparable, targetOf, type MappedConnection } from "@table-craft/desktop/main/import/mapping.js";
import { catalogEntry } from "@table-craft/desktop/main/pluginStore/catalog.js";
import {
  SSH_SECRET_KEYS,
  type Datasource,
  type DatasourceDraft,
  type ImportRow,
  type PluginInfo,
} from "@table-craft/desktop/preload/bridge.js";

const APP = "tablecraft";
export const AGENT_ACCESS_WARNING = "Agent access is off; turn it on in the data source's properties.";

/** A data source read from a TableCraft file: its preview row, its draft and the passwords it brings. */
export interface TableCraftEntry {
  readonly mapped: MappedConnection;
  /** The secret values the file holds for it, by key; empty when it holds none or they were skipped. */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface TableCraftContext {
  readonly plugins: readonly PluginInfo[];
  readonly existing: readonly Datasource[];
}

function unsupported(record: ReadRecord, row: Pick<ImportRow, "key" | "app" | "name" | "folder">): TableCraftEntry {
  const pluginId = record.datasource?.pluginId ?? null;
  const downloadable = pluginId === null ? undefined : catalogEntry(pluginId);
  return {
    mapped: {
      row: {
        ...row,
        user: null,
        pluginId: downloadable?.id ?? null,
        pluginName: downloadable?.name ?? pluginId ?? "Unknown",
        target: "",
        password: "notNeeded",
        warnings:
          record.datasource === null
            ? record.warnings
            : [`No installed plugin reads ${downloadable?.name ?? pluginId ?? "this data source"} data sources.`],
        status: "unsupported",
        selected: false,
      },
      draft: null,
      passwordKey: null,
    },
    secrets: {},
  };
}

/** Agent access is a choice made on one machine; an imported data source starts with it off (decision 153). */
function draftOf(datasource: ExportedDatasource, recordId: string): { draft: DatasourceDraft; agentWasOn: boolean } {
  const {
    id: _id,
    agentAccess,
    agentSchemas: _schemas,
    agentRowCap: _rowCap,
    agentTimeoutSeconds: _timeout,
    ...kept
  } = datasource;
  return {
    draft: { ...kept, origin: datasource.origin ?? { app: APP, id: recordId } },
    agentWasOn: agentAccess !== undefined && agentAccess !== "off",
  };
}

/** Maps one record of a TableCraft file to its preview row and draft (plan 040). */
export function mapTableCraftRecord(
  record: ReadRecord,
  secrets: DatasourceSecrets | null,
  context: TableCraftContext,
): TableCraftEntry {
  const base = {
    key: `${APP}:${record.id}`,
    app: APP,
    name: record.datasource?.name ?? record.name,
    folder: normalizeFolder(record.datasource?.folder ?? null),
  } as const;
  const datasource = record.datasource;
  const plugin =
    datasource === null
      ? undefined
      : context.plugins.find(
          (candidate) => candidate.id === datasource.pluginId && candidate.unavailableReason === null,
        );
  if (datasource === null || plugin === undefined) return unsupported(record, base);
  const { draft, agentWasOn } = draftOf(datasource, record.id);
  const warnings = [...record.warnings, ...(agentWasOn ? [AGENT_ACCESS_WARNING] : [])];
  const secretKeys = new Set<string>([
    ...plugin.fields.filter((field) => field.secret === true).map((field) => field.key),
    ...Object.values(SSH_SECRET_KEYS),
  ]);
  const carried = Object.fromEntries(Object.entries(secrets?.[record.id] ?? {}).filter(([key]) => secretKeys.has(key)));
  const passwordKey = plugin.url?.parts.password ?? plugin.fields.find((field) => field.secret === true)?.key ?? null;
  const ssh = plugin.network === null ? undefined : draft.ssh;
  const key = comparable(draft.config, plugin, ssh);
  const origin = draft.origin;
  const duplicate = context.existing.some(
    (existing) =>
      (origin !== undefined && existing.origin?.app === origin.app && existing.origin.id === origin.id) ||
      (existing.pluginId === plugin.id && comparable(existing.config, plugin, existing.ssh) === key),
  );
  const status: ImportRow["status"] = duplicate ? "duplicate" : "ready";
  const userKey = plugin.url?.parts.user;
  const target = targetOf(draft.config, plugin);
  return {
    mapped: {
      row: {
        ...base,
        user: userKey === undefined ? null : String(draft.config[userKey] ?? "") || null,
        pluginId: plugin.id,
        pluginName: plugin.name,
        target: ssh?.enabled === true ? `${target} via ${ssh.host}` : target,
        password: passwordKey === null ? "notNeeded" : Object.keys(carried).length > 0 ? "inFile" : "askOnConnect",
        warnings,
        status,
        selected: status === "ready",
      },
      draft,
      passwordKey,
    },
    secrets: carried,
  };
}
