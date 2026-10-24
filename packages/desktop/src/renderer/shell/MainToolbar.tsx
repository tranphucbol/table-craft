import { useEffect } from "react";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentPlatform } from "@table-craft/desktop/renderer/actions/chords.js";
import { useActionAvailable } from "@table-craft/desktop/renderer/actions/index.js";
import { SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { MAIN_MENU_ANCHOR_ATTRIBUTE, WINDOW_ACTION_IDS } from "@table-craft/desktop/renderer/actions/windowActions.js";
import { tabCaption, windowTitle } from "@table-craft/desktop/renderer/model/windowTitle.js";
import { DatasourceWidget } from "@table-craft/desktop/renderer/shell/DatasourceWidget.js";
import { UpdateButton } from "@table-craft/desktop/renderer/shell/UpdateButton.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useDdl } from "@table-craft/desktop/renderer/state/ddl.js";
import { useSessions } from "@table-craft/desktop/renderer/state/sessions.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { activeTab, useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { useWindowState } from "@table-craft/desktop/renderer/state/windowState.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/** The active tab and the name of its datasource, which the toolbar and the window are titled by. */
function useActiveCaption() {
  const tab = useTabs((state) => activeTab(state));
  const id = tab?.id ?? "";
  const consoleDatasource = useConsoles((state) => state.consoles[id]?.datasourceId);
  const tableDatasource = useTables((state) => state.tables[id]?.datasourceId);
  const ddlDatasource = useDdl((state) => state.ddls[id]?.datasourceId);
  const sessionsDatasource = useSessions((state) => state.tabs[id]?.datasourceId);
  const name = useDatasources(
    (state) =>
      datasourceById(state, consoleDatasource ?? tableDatasource ?? ddlDatasource ?? sessionsDatasource)?.name ?? null,
  );
  return { tab, name };
}

function AvailableButton({ actionId }: { readonly actionId: string }) {
  return useActionAvailable(actionId) ? <ActionButton actionId={actionId} compact /> : null;
}

/**
 * The window's title bar is this toolbar (decision 034): the traffic lights or the main-menu button,
 * the datasource widget, the title, the run controls, Search Everywhere, Update (only while one is
 * offered, decision 045) and Settings. Its empty
 * space drags the window; every control in it is `app-no-drag`.
 */
export function MainToolbar() {
  const custom = useWindowState((state) => state.customTitleBar);
  const fullScreen = useWindowState((state) => state.fullScreen);
  const mac = currentPlatform() === "mac";
  const { tab, name } = useActiveCaption();
  const caption = tabCaption(tab, name);
  const title = windowTitle(tab, name);

  useEffect(() => {
    // Electron mirrors it to the window, so Mission Control, the Dock and the taskbar read it.
    document.title = title;
  }, [title]);

  return (
    <div
      role="toolbar"
      aria-label="Main toolbar"
      className={cn(
        "flex h-title-bar shrink-0 items-center gap-gap border-b border-line bg-panel px-gap",
        custom && "app-drag",
        custom && mac && !fullScreen && "pl-traffic-lights",
        custom && !mac && "title-bar-overlay-inset",
      )}
    >
      {custom && !mac ? (
        <span {...{ [MAIN_MENU_ANCHOR_ATTRIBUTE]: "" }} className="app-no-drag flex">
          <AvailableButton actionId={WINDOW_ACTION_IDS.mainMenu} />
        </span>
      ) : null}
      <DatasourceWidget />
      <span data-testid="window-title" className="min-w-0 flex-1 truncate text-center text-ink-muted">
        {caption}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <ActionButton actionId={ACTION_IDS.run} compact />
        <AvailableButton actionId={ACTION_IDS.cancel} />
        <AvailableButton actionId={ACTION_IDS.commit} />
        <AvailableButton actionId={ACTION_IDS.rollback} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ActionButton actionId={ACTION_IDS.searchEverywhere} compact />
        <UpdateButton />
        <ActionButton actionId={SETTINGS_ACTION_IDS.show} compact />
      </div>
    </div>
  );
}
