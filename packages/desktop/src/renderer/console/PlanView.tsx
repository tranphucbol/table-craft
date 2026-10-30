import { useMemo, useRef, type KeyboardEvent } from "react";
import { EXPLAIN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/explainActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import {
  movedInPlan,
  planNodeAt,
  planNumber,
  planRows,
  type PlanRow,
} from "@table-craft/desktop/renderer/model/planTree.js";
import {
  useConsoles,
  type PlanTab,
  type PlanView as PlanViewKind,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CollapsedIcon, ExpandedIcon, WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";

const INDENT_PX = 16;
const RAW_LABEL = "Raw plan";
const ANALYSED_BANNER = "Explain Analyse ran this statement.";
const EFFECT_TEXT = {
  none: "",
  committed: " Its changes were committed.",
  inTransaction: " Its changes are in the open transaction.",
} as const;

interface PlanColumn {
  readonly title: string;
  readonly value: (row: PlanRow) => number | null;
  /** The column the share bar is drawn under. */
  readonly bar?: boolean;
}

function operationText(row: PlanRow): string {
  return row.node.target === null ? row.node.operation : `${row.node.operation} ${row.node.target}`;
}

function columnsOf(analyzed: boolean): readonly PlanColumn[] {
  const estimated: PlanColumn[] = [
    { title: "Rows (est.)", value: (row) => row.node.estimatedRows },
    { title: "Cost (est.)", value: (row) => row.node.estimatedCost, bar: !analyzed },
  ];
  if (!analyzed) return estimated;
  return [
    ...estimated,
    { title: "Actual Rows", value: (row) => row.node.actualRows },
    { title: "Time (ms)", value: (row) => row.node.actualTimeMs, bar: true },
    { title: "Loops", value: (row) => row.node.loops },
  ];
}

const VIEWS: readonly { readonly view: PlanViewKind; readonly label: string; readonly actionId: string }[] = [
  { view: "tree", label: "Tree", actionId: EXPLAIN_ACTION_IDS.showTree },
  { view: "raw", label: "Raw", actionId: EXPLAIN_ACTION_IDS.showRaw },
];

function Details({ plan }: { readonly plan: PlanTab }) {
  const node = planNodeAt(plan.plan, plan.selected);
  return (
    <aside
      aria-label="Plan node details"
      data-testid="plan-details"
      className="w-plan-details shrink-0 overflow-auto border-l border-line bg-panel p-gap"
    >
      {node === null ? (
        <p className="text-ink-muted">Select a node to see its details.</p>
      ) : (
        <>
          <h3 className="mb-1 font-semibold break-words">
            {node.operation}
            {node.target === null ? null : <span className="text-ink-muted"> {node.target}</span>}
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-gap gap-y-1">
            {node.detail === null ? null : (
              <>
                <dt className="text-ink-muted">Detail</dt>
                <dd className="font-grid break-words">{node.detail}</dd>
              </>
            )}
            {node.properties.map((property) => (
              <div key={property.name} className="contents">
                <dt className="text-ink-muted">{property.name}</dt>
                <dd className="font-grid break-words">{property.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </aside>
  );
}

function Tree({ consoleId, plan }: { readonly consoleId: string; readonly plan: PlanTab }) {
  const updatePlan = useConsoles((state) => state.updatePlan);
  const collapsed = useMemo(() => new Set(plan.collapsed), [plan.collapsed]);
  const rows = useMemo(() => planRows(plan.plan, collapsed), [plan.plan, collapsed]);
  const columns = columnsOf(plan.analyzed);
  const elements = useRef(new Map<string, HTMLTableRowElement>());

  function select(key: string | null): void {
    updatePlan(consoleId, plan.id, { selected: key });
    if (key !== null) elements.current.get(key)?.focus();
  }

  function toggle(row: PlanRow): void {
    const next = plan.collapsed.includes(row.key)
      ? plan.collapsed.filter((key) => key !== row.key)
      : [...plan.collapsed, row.key];
    updatePlan(consoleId, plan.id, { collapsed: next });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>): void {
    const moved = movedInPlan(rows, plan.selected, plan.collapsed, event.key);
    if (moved === null) return;
    event.preventDefault();
    if (moved.collapsed !== plan.collapsed) updatePlan(consoleId, plan.id, { collapsed: moved.collapsed });
    select(moved.selected);
  }

  if (rows.length === 0) return <p className="flex-1 p-gap text-ink-muted">The database returned no plan nodes.</p>;
  return (
    <div className="min-w-0 flex-1 overflow-auto bg-canvas">
      <table
        role="treegrid"
        aria-label={plan.title}
        className="w-full border-collapse font-grid text-grid"
        onKeyDown={onKeyDown}
      >
        <thead className="sticky top-0 z-10 bg-panel text-ink-muted">
          <tr className="h-row">
            <th className="w-full bg-panel px-cell text-left font-normal">Operation</th>
            {columns.map((column) => (
              <th key={column.title} className="w-px bg-panel px-cell text-right font-normal whitespace-nowrap">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelected = row.key === plan.selected;
            const expanded = !collapsed.has(row.key);
            return (
              <tr
                key={row.key}
                ref={(element) => {
                  if (element === null) elements.current.delete(row.key);
                  else elements.current.set(row.key, element);
                }}
                role="row"
                aria-level={row.depth + 1}
                aria-expanded={row.hasChildren ? expanded : undefined}
                aria-selected={isSelected}
                tabIndex={isSelected || (plan.selected === null && row.key === rows[0]?.key) ? 0 : -1}
                className={cn(
                  "h-row cursor-default outline-none hover:bg-raised",
                  isSelected && "bg-selection hover:bg-selection",
                )}
                onMouseDown={() => select(row.key)}
              >
                <td role="gridcell" className="max-w-0 px-cell whitespace-nowrap">
                  <span
                    className="flex min-w-0 items-center gap-1"
                    style={{ paddingLeft: `${String(row.depth * INDENT_PX)}px` }}
                  >
                    {row.hasChildren ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden
                        className="flex size-icon shrink-0 items-center justify-center text-ink-muted"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => toggle(row)}
                      >
                        {expanded ? <ExpandedIcon /> : <CollapsedIcon />}
                      </button>
                    ) : (
                      <span aria-hidden className="size-icon shrink-0" />
                    )}
                    <span className="min-w-0 truncate" title={operationText(row)}>
                      {row.node.operation}
                      {row.node.target === null ? null : <span className="text-ink-muted"> {row.node.target}</span>}
                    </span>
                  </span>
                </td>
                {columns.map((column) => (
                  <td key={column.title} role="gridcell" className="relative px-cell text-right whitespace-nowrap">
                    {planNumber(column.value(row))}
                    {column.bar === true && row.share !== null ? (
                      <span
                        aria-hidden
                        data-testid="plan-bar"
                        className="absolute bottom-0 left-0 h-plan-bar bg-plan-bar"
                        style={{ width: `${String(row.share * 100)}%` }}
                      />
                    ) : null}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A plan tab (plan 012 decisions 11 and 12): the plan as a tree-table with the selected node's
 * details beside it, or the database's own text; an analysed plan first says that the statement ran.
 */
export function PlanView({ consoleId, plan }: { readonly consoleId: string; readonly plan: PlanTab }) {
  const summary = plan.plan.summary.map((entry) => `${entry.name}: ${entry.value}`).join(" · ");
  return (
    <div data-testid="plan-view" data-view={plan.view} className="flex min-h-0 flex-1 flex-col">
      {plan.analyzed ? (
        <div
          role="status"
          data-testid="plan-banner"
          className="flex shrink-0 items-center gap-1 border-b border-line bg-analysed-banner px-gap py-1 text-ink"
        >
          <WarningIcon aria-hidden weight="fill" className="size-icon shrink-0 text-warning" />
          {ANALYSED_BANNER}
          {EFFECT_TEXT[plan.effect]}
        </div>
      ) : null}
      <div className="flex h-row shrink-0 items-center gap-gap border-b border-line bg-panel pr-gap">
        <div role="group" aria-label="Plan view" className="flex shrink-0 self-stretch border-r border-line">
          {VIEWS.map(({ view, label, actionId }) => (
            <button
              key={view}
              type="button"
              aria-pressed={plan.view === view}
              className="px-gap text-ink aria-pressed:bg-selection"
              onClick={() => invoke(actionId)}
            >
              {label}
            </button>
          ))}
        </div>
        <ActionButton actionId={EXPLAIN_ACTION_IDS.rerun} compact />
        <ActionButton actionId={EXPLAIN_ACTION_IDS.copy} compact />
        <span data-testid="plan-summary" className="min-w-0 truncate text-ink-muted" title={summary}>
          {summary}
        </span>
      </div>
      {plan.view === "raw" ? (
        <SqlView
          text={plan.plan.raw}
          highlight={null}
          label={RAW_LABEL}
          testId="plan-raw"
          className="flex-1 bg-canvas"
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Tree consoleId={consoleId} plan={plan} />
          <Details plan={plan} />
        </div>
      )}
    </div>
  );
}
