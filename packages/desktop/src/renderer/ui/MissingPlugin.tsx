import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { buttonClass } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { PLUGIN_ACTION_IDS, type PluginArgs } from "@table-craft/desktop/renderer/actions/pluginActions.js";
import { UPDATE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/updateActions.js";
import {
  missingPlugin,
  missingText,
  NEWER_APP_TEXT,
  needsNewerApp,
  pluginNeed,
} from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

function NoticeButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      className={buttonClass()}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

/**
 * What a data source whose plugin is not installed shows instead of its plugin's name: that the
 * plugin is missing with an Install button, then the download's progress or failure (decision 110).
 * A plugin built for an older TableCraft reads as an update, one built for a newer TableCraft offers
 * the app's update (decision 155). Nothing when the plugin is usable or TableCraft cannot download it.
 */
export function MissingPlugin({ pluginId }: { readonly pluginId: string }) {
  const entry = useDatasources((state) => missingPlugin(state.catalog, state.plugins, pluginId));
  const outdated = useDatasources((state) => pluginNeed(state.plugins, pluginId) === "pluginUpdate");
  const newerApp = useDatasources((state) => needsNewerApp(state.plugins, pluginId));
  if (newerApp) {
    return (
      <span data-missing-plugin={pluginId} className="flex min-w-0 items-center gap-cell">
        <span role="status" title={NEWER_APP_TEXT.title} className="truncate text-ink-muted">
          {NEWER_APP_TEXT.text}
        </span>
        <NoticeButton label="Check for Updates" onClick={() => invoke(UPDATE_ACTION_IDS.check)} />
      </span>
    );
  }
  if (entry === undefined) return null;
  const { text, title } = missingText(entry, outdated);
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
        <NoticeButton
          label={failed ? "Retry" : outdated ? "Update" : "Install"}
          onClick={() => invoke(PLUGIN_ACTION_IDS.install, args)}
        />
      )}
    </span>
  );
}
