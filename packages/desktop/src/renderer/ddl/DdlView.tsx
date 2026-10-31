import { DDL_ACTION_IDS } from "@table-craft/desktop/renderer/actions/ddlActions.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useDdl } from "@table-craft/desktop/renderer/state/ddl.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

const DDL_LABEL = "DDL";

/** A relation's definition as the database states it, read-only (plan 010 decision 8). */
export function DdlView({ ddlId }: { readonly ddlId: string }) {
  const tab = useDdl((state) => state.ddls[ddlId]);
  const datasource = useConsoleDatasource(ddlId);
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? ""));
  if (tab === undefined) return null;
  const color = datasource?.color ?? null;
  return (
    <div
      data-testid="ddl-view"
      data-color={color ?? undefined}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <div className="flex h-tab shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted">
        <ActionButton actionId={DDL_ACTION_IDS.refresh} compact />
        <ActionButton actionId={DDL_ACTION_IDS.copy} compact />
        <ActionButton actionId={DDL_ACTION_IDS.openInConsole} compact />
        <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        <span data-testid="ddl-status" className="truncate">
          {tab.loading ? "Reading definition…" : [...tab.path, tab.relation].join(".")}
        </span>
        {datasource === undefined ? null : (
          <span className="ml-auto shrink-0">
            {datasource.name}
            {plugin === undefined ? "" : ` · ${plugin.name}`}
          </span>
        )}
      </div>
      {tab.error === null ? null : (
        <div
          role="alert"
          data-testid="ddl-error"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger"
        >
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      <SqlView
        text={tab.text ?? ""}
        highlight={plugin?.highlight}
        label={DDL_LABEL}
        testId="ddl-text"
        className="flex-1 bg-canvas"
      />
    </div>
  );
}
