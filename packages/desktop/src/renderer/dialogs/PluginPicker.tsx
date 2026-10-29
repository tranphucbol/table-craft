import { useEffect, useRef } from "react";
import type { Brand, CatalogPlugin, PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { PLUGIN_ACTION_IDS, type PluginArgs } from "@table-craft/desktop/renderer/actions/pluginActions.js";
import {
  downloadLabel,
  entryName,
  installText,
  pickerEntries,
} from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { DatasourceGlyph } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";

const ROW_CLASS =
  "flex min-h-row w-full items-center gap-cell rounded px-gap text-left hover:bg-raised disabled:opacity-50";

function DownloadRow({ entry, onDownload }: { readonly entry: CatalogPlugin; readonly onDownload: () => void }) {
  const DownloadIcon = ACTION_ICONS.download;
  const progress = installText(entry);
  const failed = entry.install.status === "failed";
  return (
    <button
      type="button"
      data-download={entry.id}
      disabled={entry.install.status === "installing"}
      title={entry.install.status === "failed" ? entry.install.hint : undefined}
      className={ROW_CLASS}
      onClick={onDownload}
    >
      <DatasourceGlyph brand={entry.brands[0] ?? null} className="size-icon shrink-0 text-ink-muted" />
      <span className="shrink-0">{entry.name}</span>
      {progress === null ? (
        <span className="flex items-center gap-1 text-ink-muted">
          <DownloadIcon aria-hidden className="size-icon" />
          {downloadLabel(entry)}
        </span>
      ) : (
        <span role={failed ? "alert" : "status"} className={cn("truncate", failed ? "text-danger" : "text-ink-muted")}>
          {progress}
          {entry.install.status === "failed" ? <span className="text-ink-muted"> {entry.install.hint}</span> : null}
        </span>
      )}
    </button>
  );
}

/**
 * The New Data Source list: installed plugins, then the ones TableCraft can download (decision 110).
 * A downloaded one opens its form once main reports it installed.
 */
export function PluginPicker({
  plugins,
  catalog,
  onPick,
}: {
  readonly plugins: readonly PluginInfo[];
  readonly catalog: readonly CatalogPlugin[];
  /** `brand` is the product the row names; null for a plugin that names none. */
  readonly onPick: (plugin: PluginInfo, brand: Brand | null) => void;
}) {
  const waiting = useRef<(() => void) | null>(null);
  useEffect(() => () => waiting.current?.(), []);

  function download(pluginId: string): void {
    waiting.current?.();
    const off = useDatasources.subscribe((state) => {
      const installed = state.plugins.find((plugin) => plugin.id === pluginId);
      if (installed === undefined || installed.unavailableReason !== null) return;
      off();
      waiting.current = null;
      onPick(installed, installed.brands[0] ?? null);
    });
    waiting.current = off;
    const args: PluginArgs = { pluginId };
    invoke(PLUGIN_ACTION_IDS.install, args);
  }

  return (
    <div className="flex flex-col gap-gap p-gap">
      <h3 className="font-semibold">New data source</h3>
      <p className="text-ink-muted">Choose the kind of database.</p>
      <ul aria-label="Database kinds" className="flex flex-col gap-1">
        {pickerEntries(plugins, catalog).map((item) =>
          item.kind === "plugin" ? (
            <li key={`${item.plugin.id}:${item.brand?.id ?? ""}`}>
              <button
                type="button"
                data-brand={item.brand?.id}
                disabled={item.plugin.unavailableReason !== null}
                title={item.plugin.unavailableReason ?? undefined}
                className={ROW_CLASS}
                onClick={() => onPick(item.plugin, item.brand)}
              >
                <DatasourceGlyph brand={item.brand} className="size-icon shrink-0 text-accent" />
                <span className="shrink-0">{entryName(item)}</span>
                {item.plugin.unavailableReason === null ? null : (
                  <span className="text-ink-muted">{item.plugin.unavailableReason}</span>
                )}
              </button>
            </li>
          ) : (
            <li key={item.entry.id}>
              <DownloadRow entry={item.entry} onDownload={() => download(item.entry.id)} />
            </li>
          ),
        )}
      </ul>
      <button
        type="button"
        className="self-start text-accent hover:underline"
        onClick={() => invoke(PLUGIN_ACTION_IDS.show)}
      >
        Manage plugins…
      </button>
    </div>
  );
}
