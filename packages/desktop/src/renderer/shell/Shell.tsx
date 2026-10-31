import type { ReactNode } from "react";
import { Group, Panel, type Layout } from "react-resizable-panels";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { SERVICES_ACTION_IDS } from "@table-craft/desktop/renderer/actions/servicesActions.js";
import { SNIPPET_ACTION_IDS } from "@table-craft/desktop/renderer/actions/snippetActions.js";
import { DatabasePane } from "@table-craft/desktop/renderer/panes/DatabasePane.js";
import { LogPane } from "@table-craft/desktop/renderer/panes/LogPane.js";
import { ServicesPane } from "@table-craft/desktop/renderer/panes/ServicesPane.js";
import { EditorArea } from "@table-craft/desktop/renderer/shell/EditorArea.js";
import { MainToolbar } from "@table-craft/desktop/renderer/shell/MainToolbar.js";
import { StatusBar } from "@table-craft/desktop/renderer/shell/StatusBar.js";
import { Stripe } from "@table-craft/desktop/renderer/shell/Stripe.js";
import { ToolWindow } from "@table-craft/desktop/renderer/shell/ToolWindow.js";
import { ISLAND_SURFACE } from "@table-craft/desktop/renderer/shell/islands.js";
import { useLayout, type ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { useIslands } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Handle } from "@table-craft/desktop/renderer/ui/Handle.js";
import { WatchPane } from "@table-craft/desktop/renderer/watch/WatchPane.js";
import { WATCH_ACTION_IDS } from "@table-craft/desktop/renderer/watch/actions.js";
import { AdminSecretPrompt } from "@table-craft/desktop/renderer/keyAdmin/SecretPrompt.js";

const LEFT_STRIPE_TOP = [
  { toolWindow: "database", actionId: ACTION_IDS.toggleDatabase },
  { actionId: SNIPPET_ACTION_IDS.show },
] as const;
const LEFT_STRIPE_BOTTOM = [
  { toolWindow: "watch", actionId: WATCH_ACTION_IDS.toggle },
  { toolWindow: "services", actionId: ACTION_IDS.toggleServices },
] as const;
const RIGHT_STRIPE_TOP = [
  { toolWindow: "log", actionId: ACTION_IDS.toggleLog },
  { actionId: MCP_ACTION_IDS.settings },
] as const;
const SERVICES_FOLD_ACTIONS = [SERVICES_ACTION_IDS.collapseAll, SERVICES_ACTION_IDS.expandAll] as const;
const MIN_TOOL_WINDOW_PERCENT = "10";
const MIN_EDITOR_PERCENT = "20";
const MIN_WATCH_PERCENT = "40%";
/** The library's panels scroll by default; ours lay out their own scrolling regions. */
const PANEL_STYLE = { overflow: "hidden" } as const;
const CLASSIC_SURFACE = "h-full min-h-0";

/** Writes a dragged size back to the layout store; sizes the library computes on its own are ignored. */
function persistSize(...ids: readonly ToolWindowId[]) {
  return (layout: Layout, meta: { readonly isUserInteraction: boolean }) => {
    if (!meta.isUserInteraction) return;
    for (const id of ids) {
      const size = layout[id];
      if (size !== undefined) useLayout.getState().resize(id, size);
    }
  };
}

const persistSides = persistSize("database", "log");
const persistServices = persistSize("services", "watch");

/** Always the same element whatever the style, so switching it never remounts the editor beneath. */
function Island({ children }: { readonly children: ReactNode }) {
  const islands = useIslands();
  return <div className={islands ? ISLAND_SURFACE : CLASSIC_SURFACE}>{children}</div>;
}

/** DataGrip's frame: the main toolbar, stripes, Database left, editor tabs centre, Services bottom, status bar. */
export function Shell() {
  const visible = useLayout((state) => state.layout.visible);
  const sizes = useLayout((state) => state.layout.sizes);
  const islands = useIslands();
  return (
    <main className={cn("flex h-full flex-col text-ink", islands ? "bg-frame" : "bg-canvas")}>
      <MainToolbar />
      <div className="flex min-h-0 flex-1">
        <Stripe side="left" top={LEFT_STRIPE_TOP} bottom={LEFT_STRIPE_BOTTOM} />
        <div className={cn("flex min-w-0 flex-1", islands && "p-island-gap")}>
          <Group orientation="vertical" className="min-w-0 flex-1" onLayoutChanged={persistServices}>
            <Panel id="main" minSize={MIN_EDITOR_PERCENT} style={PANEL_STYLE}>
              <Group orientation="horizontal" onLayoutChanged={persistSides}>
                {visible.database ? (
                  <>
                    <Panel
                      id="database"
                      defaultSize={String(sizes.database)}
                      minSize={MIN_TOOL_WINDOW_PERCENT}
                      style={PANEL_STYLE}
                    >
                      <Island>
                        <ToolWindow id="database" title="Database" toggleActionId={ACTION_IDS.toggleDatabase}>
                          <DatabasePane />
                        </ToolWindow>
                      </Island>
                    </Panel>
                    <Handle axis="vertical" gutter />
                  </>
                ) : null}
                <Panel id="editor" minSize={MIN_EDITOR_PERCENT} style={PANEL_STYLE}>
                  <Island>
                    <EditorArea />
                  </Island>
                </Panel>
                {visible.log ? (
                  <>
                    <Handle axis="vertical" gutter />
                    <Panel
                      id="log"
                      defaultSize={String(sizes.log)}
                      minSize={MIN_TOOL_WINDOW_PERCENT}
                      style={PANEL_STYLE}
                    >
                      <Island>
                        <ToolWindow id="log" title="Log" toggleActionId={ACTION_IDS.toggleLog}>
                          <LogPane />
                        </ToolWindow>
                      </Island>
                    </Panel>
                  </>
                ) : null}
              </Group>
            </Panel>
            {visible.watch ? (
              <>
                <Handle axis="horizontal" gutter />
                <Panel id="watch" defaultSize={String(sizes.watch)} minSize={MIN_WATCH_PERCENT} style={PANEL_STYLE}>
                  <Island>
                    <ToolWindow id="watch" title="Watch" toggleActionId={WATCH_ACTION_IDS.toggle}>
                      <WatchPane />
                    </ToolWindow>
                  </Island>
                </Panel>
              </>
            ) : null}
            {visible.services ? (
              <>
                <Handle axis="horizontal" gutter />
                <Panel
                  id="services"
                  defaultSize={String(sizes.services)}
                  minSize={MIN_TOOL_WINDOW_PERCENT}
                  style={PANEL_STYLE}
                >
                  <Island>
                    <ToolWindow
                      id="services"
                      title="Services"
                      toggleActionId={ACTION_IDS.toggleServices}
                      switchingActions={SERVICES_FOLD_ACTIONS}
                    >
                      <ServicesPane />
                    </ToolWindow>
                  </Island>
                </Panel>
              </>
            ) : null}
          </Group>
        </div>
        <Stripe side="right" top={RIGHT_STRIPE_TOP} />
      </div>
      <StatusBar />
      <AdminSecretPrompt />
    </main>
  );
}
