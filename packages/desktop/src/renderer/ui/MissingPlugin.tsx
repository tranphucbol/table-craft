import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { PLUGIN_ACTION_IDS, type PluginArgs } from "@table-craft/desktop/renderer/actions/pluginActions.js";
import { missingPlugin, missingText } from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/**
 * What a data source whose plugin is not installed shows instead of its plugin's name: that the
 * plugin is missing with an Install button, then the download's progress or failure (decision 110).
 * Nothing when the plugin is installed or TableCraft cannot download it.
 */
export function MissingPlugin({ pluginId }: { readonly pluginId: string }) {
  const entry = useDatasources((state) => missingPlugin(state.catalog, state.plugins, pluginId));
  if (entry === undefined) return null;
  const { text, title } = missingText(entry);
  const failed = entry.install.status === "failed";
  const args: PluginArgs = { pluginId };
  return (
    <span data-missing-plugin={pluginId} className="flex min-w-0 items-center gap-cell">
      <span
        role={entry.install.status === "idle" ? undefined : failed ? "alert" : "status"}
        title={title}
        className={cn("truncate", failed ? "text-danger" : "text-ink-muted")}
      >
        {text}
      </span>
      {entry.install.status === "installing" ? null : (
        <button
          type="button"
          className="shrink-0 rounded border border-line px-1 text-ink hover:bg-raised"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            invoke(PLUGIN_ACTION_IDS.install, args);
          }}
        >
          {failed ? "Retry" : "Install"}
        </button>
      )}
    </span>
  );
}
