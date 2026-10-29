import { useRef, useState } from "react";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { Button } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { relativeTime } from "@table-craft/desktop/renderer/model/format.js";
import {
  timeoutExplanation,
  type Coverage,
  type CoverageRow,
  type TimeoutExplanation,
  type TimeoutTone,
} from "@table-craft/desktop/renderer/model/timeoutExplain.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { DatasourceGlyph, useDatasourceBrand } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import {
  CoveredIcon,
  InfoIcon,
  NotCoveredIcon,
  NotSeenIcon,
  WarningIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";

type CoverageIcon = typeof CoveredIcon;

const COVERAGE_CELLS: Readonly<Record<Coverage, { icon: CoverageIcon; word: string; tone: string }>> = {
  stops: { icon: CoveredIcon, word: "Stops", tone: "text-success" },
  dropsConnection: { icon: WarningIcon, word: "Drops connection", tone: "text-warning" },
  blockingOnly: { icon: WarningIcon, word: "Blocking only", tone: "text-warning" },
  none: { icon: NotCoveredIcon, word: "Not covered", tone: "text-ink-muted" },
  unknown: { icon: NotSeenIcon, word: "Not seen", tone: "text-ink-muted" },
};

const TONE_CLASSES: Readonly<Record<TimeoutTone, string>> = {
  covered: "text-ink-muted",
  gap: "text-warning",
  unseen: "rounded-full text-ink-muted outline-1 outline-line outline-dashed",
};

const COLUMNS = [
  { key: "reads", label: "Reads" },
  { key: "writes", label: "Writes & other" },
] as const satisfies readonly { key: keyof CoverageRow; label: string }[];

const SOURCE_TEXT: Readonly<Record<TimeoutExplanation["source"], string>> = {
  datasource: "this data source's own",
  default: "the Statement timeout above",
};

const NOT_SEEN_YET = "Not seen yet";

function CoverageCell({ coverage }: { readonly coverage: Coverage }) {
  const cell = COVERAGE_CELLS[coverage];
  const Icon = cell.icon;
  return (
    <td className="px-cell py-1" data-coverage={coverage}>
      <span className="flex items-center gap-1 whitespace-nowrap">
        <Icon aria-hidden weight="bold" className={cn("size-icon shrink-0", cell.tone)} />
        {cell.word}
      </span>
    </td>
  );
}

function CoverageTable({ explanation }: { readonly explanation: TimeoutExplanation }) {
  const rows = [
    { label: "TableCraft", row: explanation.table.app },
    { label: explanation.product, row: explanation.table.server },
  ];
  return (
    <table className="border-collapse" aria-label="What stops a statement at the limit">
      <thead>
        <tr>
          <td />
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cn(
                "px-cell pb-1 text-left font-normal",
                explanation.gaps[column.key] ? "text-warning" : "text-ink-muted",
              )}
            >
              {column.label}
              {explanation.gaps[column.key] ? <span className="sr-only"> (gap)</span> : null}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, row }) => (
          <tr key={label} className="border-t border-line">
            <th scope="row" className="py-1 pr-cell text-left font-normal text-ink-muted">
              {label}
            </th>
            {COLUMNS.map((column) => (
              <CoverageCell key={column.key} coverage={row[column.key]} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function seenText(explanation: TimeoutExplanation, now: number): string {
  if (explanation.seenAt === null) return NOT_SEEN_YET;
  const version = explanation.version === null ? "" : ` ${explanation.version}`;
  return `Seen on ${explanation.product}${version} · ${relativeTime(explanation.seenAt, now)}`;
}

function Explainer({
  datasource,
  explanation,
}: {
  readonly datasource: DatasourceView;
  readonly explanation: TimeoutExplanation;
}) {
  const brand = useDatasourceBrand(datasource);
  const [now] = useState(() => Date.now());
  return (
    <div className="flex min-w-0 flex-col gap-cell p-cell">
      <div className="flex min-w-0 items-center gap-cell">
        <DatasourceGlyph brand={brand} className="size-icon shrink-0" />
        <span className="min-w-0 truncate font-semibold">{datasource.name}</span>
        <span className="shrink-0 text-ink-muted">
          {explanation.product}
          {explanation.version === null ? null : ` ${explanation.version}`}
        </span>
      </div>
      <p data-testid="mcp-timeout-limit">
        <span className="font-editor tabular-nums">{explanation.seconds} s</span>
        <span className="text-ink-muted">, {SOURCE_TEXT[explanation.source]}</span>
      </p>
      <CoverageTable explanation={explanation} />
      {explanation.sentences.map((sentence) => (
        <p key={sentence} className="text-ui">
          {sentence}
        </p>
      ))}
      <div className="flex items-center gap-cell border-t border-line pt-cell">
        <span data-testid="mcp-timeout-seen" className="min-w-0 flex-1 truncate text-ink-muted">
          {seenText(explanation, now)}
        </span>
        <Button data-testid="mcp-timeout-test" onClick={() => invoke(MCP_ACTION_IDS.testDatasource, datasource.id)}>
          Test Connection…
        </Button>
      </div>
    </div>
  );
}

/**
 * The (i) beside an agent's timeout on Settings › MCP Server (plan 121): its colour says whether
 * the limit stops every statement, and a click shows who stops what, from what the server last
 * said (decision 131).
 */
export function TimeoutInfo({
  datasource,
  defaultSeconds,
}: {
  readonly datasource: DatasourceView;
  readonly defaultSeconds: number;
}) {
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource.pluginId));
  const explanation = timeoutExplanation({ datasource, plugin, defaultSeconds });
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  // A press on the (i) while open closes the popover as an outside press; the click must not reopen it.
  const closedByPress = useRef(false);
  const label = `How the timeout works on ${datasource.name}`;

  const toggle = () => {
    if (closedByPress.current) {
      closedByPress.current = false;
      return;
    }
    if (anchor !== null || button.current === null) {
      setAnchor(null);
      return;
    }
    button.current.focus();
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        title={explanation.summary}
        data-testid="mcp-timeout-info"
        data-tone={explanation.tone}
        className={cn(
          "shrink-0 hover:bg-raised",
          explanation.tone !== "unseen" && "rounded",
          TONE_CLASSES[explanation.tone],
        )}
        onClick={toggle}
      >
        <InfoIcon aria-hidden className="size-icon" />
      </button>
      {anchor === null ? null : (
        <Popover
          anchor={anchor}
          label={label}
          testId="mcp-timeout-explainer"
          onOutside={(target) => {
            closedByPress.current = target instanceof Node && button.current?.contains(target) === true;
          }}
          onClose={() => setAnchor(null)}
        >
          <Explainer datasource={datasource} explanation={explanation} />
        </Popover>
      )}
    </>
  );
}
