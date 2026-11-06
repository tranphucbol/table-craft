import type { ReactNode } from "react";
import {
  CHART_AGGREGATES,
  CHART_KINDS,
  type ChartAggregate,
  type ChartKind,
  type ChartSpec,
  type Column,
  type TypeClass,
} from "@table-craft/desktop/engine/protocol.js";
import { GRID_HELPER_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridHelperActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { CHART_SERIES_VARIABLES } from "@table-craft/desktop/renderer/chart/palette.js";
import { isNumericClass, withKind } from "@table-craft/desktop/renderer/model/chartSpec.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { Dropdown, type DropdownOption } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { SEGMENT, SEGMENT_GROUP } from "@table-craft/desktop/renderer/ui/Segmented.js";
import { ToolbarDivider } from "@table-craft/desktop/renderer/ui/ToolbarDivider.js";

const KIND_LABELS: Readonly<Record<ChartKind, string>> = {
  bar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  scatter: "Scatter",
  histogram: "Histogram",
  stock: "Stock",
};

const AGGREGATE_LABELS: Readonly<Record<ChartAggregate, string>> = {
  sum: "Sum",
  avg: "Average",
  count: "Count",
  min: "Min",
  max: "Max",
};

const STOCK_LABELS = ["Open", "High", "Low", "Close"] as const;
const NONE = "none";
const AUTO = "auto";
const BIN_CHOICES = [5, 10, 20, 30, 50, 100] as const;
/** Why a kind's button is off: what the result lacks for it. */
const KIND_NEEDS: Readonly<Record<ChartKind, string>> = {
  bar: "Needs a numeric column",
  line: "Needs a numeric column",
  area: "Needs a numeric column",
  pie: "Needs a numeric column",
  scatter: "Needs a numeric column",
  histogram: "Needs a numeric column",
  stock: "Needs four numeric columns: open, high, low, close",
};

const ADD_VALUE = "add";
const ADD_VALUE_LABEL = "+ Value";
/** Series beyond the palette repeat its tints, as ECharts does. */
const PALETTE_SIZE = CHART_SERIES_VARIABLES.length;

function set(spec: ChartSpec): void {
  invoke(GRID_HELPER_ACTION_IDS.setChart, { spec });
}

function columnOptions(columns: readonly Column[], indices: readonly number[]): DropdownOption[] {
  return indices.map((index) => ({ value: String(index), label: columns[index]?.name ?? "" }));
}

/** Whether the X column folds rows into categories, so the aggregate means something. */
function folds(spec: ChartSpec, classes: readonly TypeClass[]): boolean {
  if (spec.kind === "bar" || spec.kind === "pie") return true;
  if (spec.kind !== "line" && spec.kind !== "area") return false;
  const xClass = spec.x === null ? undefined : classes[spec.x];
  return xClass !== "temporal" && !isNumericClass(xClass);
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="text-ink-muted">{label}</span>
      {children}
    </span>
  );
}

function ValueChip({
  name,
  at,
  onRemove,
  removable,
}: {
  readonly name: string;
  readonly at: number;
  readonly onRemove: () => void;
  readonly removable: boolean;
}) {
  return (
    <span
      data-chart-value={name}
      className="flex h-segment shrink-0 items-center gap-1 rounded border border-line px-1"
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `var(${CHART_SERIES_VARIABLES[at % PALETTE_SIZE] ?? CHART_SERIES_VARIABLES[0]})` }}
      />
      {name}
      {removable ? (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          className="rounded px-0.5 text-ink-muted hover:bg-hover hover:text-ink"
          onClick={onRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/**
 * The chart's settings above the plot (plan 155 decision 7): its kind, then the columns that kind
 * reads. Every change goes through `grid.setChart`.
 */
export function ChartBar({
  spec,
  columns,
  classes,
  zoomed,
}: {
  readonly spec: ChartSpec;
  readonly columns: readonly Column[];
  readonly classes: readonly TypeClass[];
  /** The plot's zoom window shows less than every point. */
  readonly zoomed: boolean;
}) {
  const all = columns.map((_, index) => index);
  const numeric = all.filter((index) => isNumericClass(classes[index]));
  const xChoices = all.filter((index) => !spec.y.includes(index));
  const single = spec.kind === "pie" || spec.kind === "histogram";
  const grouped = !single && spec.kind !== "stock";
  const remaining = numeric.filter((index) => !spec.y.includes(index) && index !== spec.x);
  return (
    <div
      role="toolbar"
      aria-label="Chart"
      data-testid="chart-bar"
      className="flex min-h-row shrink-0 items-center gap-x-gap border-b border-line bg-panel px-1 py-0.5 whitespace-nowrap"
    >
      {/* One line that scrolls sideways when narrow, its scrollbar hidden: a wrapped bar eats the plot's height. */}
      <div className="flex min-w-0 flex-1 items-center gap-x-gap overflow-x-auto [scrollbar-width:none]">
        <div role="group" aria-label="Chart kind" className={SEGMENT_GROUP}>
          {CHART_KINDS.map((kind) => {
            const next = kind === spec.kind ? spec : withKind(spec, kind, columns, classes);
            return (
              <button
                key={kind}
                type="button"
                data-chart-kind-option={kind}
                aria-pressed={kind === spec.kind}
                disabled={next === null}
                title={next === null ? KIND_NEEDS[kind] : undefined}
                className={SEGMENT}
                onClick={() => {
                  if (next !== null && kind !== spec.kind) set(next);
                }}
              >
                {KIND_LABELS[kind]}
              </button>
            );
          })}
        </div>
        <ToolbarDivider />
        {spec.kind === "histogram" ? null : (
          <Field label={spec.kind === "pie" ? "Label" : "X axis"}>
            <Dropdown
              label={spec.kind === "pie" ? "Label column" : "X column"}
              variant="inline"
              testId="chart-x"
              value={String(spec.x)}
              options={columnOptions(columns, xChoices)}
              onChange={(chosen) => set({ ...spec, x: Number(chosen) })}
            />
          </Field>
        )}
        {spec.kind === "stock" ? (
          STOCK_LABELS.map((label, at) => (
            <Field key={label} label={label}>
              <Dropdown
                label={`${label} column`}
                variant="inline"
                testId={`chart-${label.toLowerCase()}`}
                value={String(spec.y[at])}
                options={columnOptions(columns, numeric)}
                onChange={(chosen) =>
                  set({ ...spec, y: spec.y.map((was, index) => (index === at ? Number(chosen) : was)) })
                }
              />
            </Field>
          ))
        ) : single ? (
          <Field label="Value">
            <Dropdown
              label="Value column"
              variant="inline"
              testId="chart-value"
              value={String(spec.y[0])}
              options={columnOptions(columns, numeric)}
              onChange={(chosen) => set({ ...spec, y: [Number(chosen)] })}
            />
          </Field>
        ) : (
          <Field label="Values">
            {spec.y.map((index, at) => (
              <ValueChip
                key={index}
                name={columns[index]?.name ?? ""}
                at={at}
                removable={spec.y.length > 1}
                onRemove={() => set({ ...spec, y: spec.y.filter((was) => was !== index) })}
              />
            ))}
            {remaining.length > 0 ? (
              <Dropdown
                label="Add a value column"
                variant="inline"
                testId="chart-add-value"
                value={ADD_VALUE}
                options={[
                  { value: ADD_VALUE, label: ADD_VALUE_LABEL, disabled: true },
                  ...columnOptions(columns, remaining),
                ]}
                onChange={(chosen) => set({ ...spec, y: [...spec.y, Number(chosen)] })}
              />
            ) : null}
          </Field>
        )}
        {grouped ? (
          <Field label="Group by">
            <Dropdown
              label="Group by column"
              variant="inline"
              testId="chart-group-by"
              value={spec.groupBy === null ? NONE : String(spec.groupBy)}
              options={[
                { value: NONE, label: "None" },
                ...columnOptions(
                  columns,
                  all.filter((index) => index !== spec.x && !spec.y.includes(index)),
                ),
              ]}
              onChange={(chosen) => set({ ...spec, groupBy: chosen === NONE ? null : Number(chosen) })}
            />
          </Field>
        ) : null}
        {folds(spec, classes) ? (
          <Field label="Aggregate">
            <Dropdown
              label="Aggregate"
              variant="inline"
              testId="chart-aggregate"
              value={spec.aggregate}
              options={CHART_AGGREGATES.map((aggregate) => ({ value: aggregate, label: AGGREGATE_LABELS[aggregate] }))}
              onChange={(chosen) => {
                const aggregate = CHART_AGGREGATES.find((known) => known === chosen);
                if (aggregate !== undefined) set({ ...spec, aggregate });
              }}
            />
          </Field>
        ) : null}
        {spec.kind === "histogram" ? (
          <Field label="Bins">
            <Dropdown
              label="Bins"
              variant="inline"
              testId="chart-bins"
              value={spec.bins === null ? AUTO : String(spec.bins)}
              options={[
                { value: AUTO, label: "Auto" },
                ...BIN_CHOICES.map((bins) => ({ value: String(bins), label: String(bins) })),
              ]}
              onChange={(chosen) => set({ ...spec, bins: chosen === AUTO ? null : Number(chosen) })}
            />
          </Field>
        ) : null}
      </div>
      {zoomed ? <ActionButton actionId={GRID_HELPER_ACTION_IDS.resetChartZoom} /> : null}
      <ActionButton actionId={GRID_HELPER_ACTION_IDS.exportChart} compact />
    </div>
  );
}
