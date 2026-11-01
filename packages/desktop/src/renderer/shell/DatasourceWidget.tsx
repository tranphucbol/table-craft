import * as Primitive from "@radix-ui/react-popover";
import { useState } from "react";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { WINDOW_ACTION_IDS, type SwitchToArgs } from "@table-craft/desktop/renderer/actions/windowActions.js";
import { ConnectionDot, useActiveDatasourceId } from "@table-craft/desktop/renderer/shell/statusItems.js";
import { connectionOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { DropdownIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { SURFACE_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";
import { TINT_SWATCH } from "@table-craft/desktop/renderer/ui/tint.js";

const SIDE_OFFSET_PX = 4;
const NO_DATASOURCE = "No data source";
const ROW_CLASS = "app-no-drag flex h-row w-full items-center gap-cell rounded px-cell text-left hover:bg-selection";

function Swatch({ datasource }: { readonly datasource: DatasourceView }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0 rounded-sm",
        datasource.color === null ? "border border-ink-muted" : TINT_SWATCH[datasource.color],
      )}
    />
  );
}

function DatasourceRow({
  datasource,
  onChosen,
}: {
  readonly datasource: DatasourceView;
  readonly onChosen: () => void;
}) {
  const status = useDatasources((state) => connectionOf(state, datasource.id).status);
  const connected = status === "connected";
  return (
    <button
      type="button"
      className={ROW_CLASS}
      onClick={() => {
        onChosen();
        invoke(WINDOW_ACTION_IDS.switchTo, { datasourceId: datasource.id } satisfies SwitchToArgs);
      }}
    >
      <Swatch datasource={datasource} />
      <span className="min-w-0 flex-1 truncate">{datasource.name}</span>
      <span className={cn("shrink-0 text-ink-muted", connected && "text-success")}>
        {connected ? "connected" : "disconnected"}
      </span>
    </button>
  );
}

function ActionRow({
  actionId,
  label,
  onChosen,
}: {
  readonly actionId: string;
  readonly label: string;
  readonly onChosen: () => void;
}) {
  return (
    <button
      type="button"
      className={ROW_CLASS}
      onClick={() => {
        onChosen();
        invoke(actionId);
      }}
    >
      {label}
    </button>
  );
}

/**
 * DataGrip's project widget, for datasources (plan 015 decision 9): the datasource the status bar
 * names, and a list that switches to another one.
 */
export function DatasourceWidget() {
  const [open, setOpen] = useState(false);
  const datasourceId = useActiveDatasourceId();
  const active = useDatasources((state) => datasourceById(state, datasourceId));
  const status = useDatasources((state) => connectionOf(state, datasourceId ?? "").status);
  const datasources = useDatasources((state) => state.datasources);
  const close = () => setOpen(false);
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        <button
          type="button"
          aria-label="Data source"
          className="app-no-drag flex h-row max-w-64 min-w-0 shrink-0 items-center gap-cell rounded px-cell text-ink hover:bg-raised"
          onMouseDown={(event) => event.preventDefault()}
        >
          {active === undefined ? (
            <span className="truncate text-ink-muted">{NO_DATASOURCE}</span>
          ) : (
            <>
              <Swatch datasource={active} />
              <span className="min-w-0 truncate font-semibold">{active.name}</span>
              <ConnectionDot datasourceId={datasourceId} status={status} />
            </>
          )}
          <DropdownIcon aria-hidden className="size-3 shrink-0 text-ink-muted" />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side="bottom"
          align="start"
          sideOffset={SIDE_OFFSET_PX}
          collisionPadding={SIDE_OFFSET_PX}
          aria-label="Switch data source"
          className={cn(
            "app-no-drag z-50 flex max-h-popover-height w-max max-w-popover min-w-56 flex-col overflow-y-auto rounded border border-line bg-raised p-1 text-ui text-ink shadow-lg outline-none",
            SURFACE_MOTION,
          )}
        >
          {datasources.map((datasource) => (
            <DatasourceRow key={datasource.id} datasource={datasource} onChosen={close} />
          ))}
          {datasources.length > 0 ? <hr className="my-1 border-line" /> : null}
          <ActionRow actionId={ACTION_IDS.newDatasource} label="New Data Source…" onChosen={close} />
          <ActionRow actionId={ACTION_IDS.datasourceProperties} label="Data Sources…" onChosen={close} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
