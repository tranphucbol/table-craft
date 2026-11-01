import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { RUN_SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/runSettingsActions.js";
import { SETTINGS_ACTION_IDS, type ShowSettingsArgs } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { FIELD_GRID_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { NumberField } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import {
  DEFAULT_RUN_SETTINGS,
  effectiveRunSettings,
  isDefaultRunSettings,
  RUN_ROWS_RANGE,
  RUN_TIMEOUT_RANGE,
  runRowsError,
  runSettingsSummary,
  runTimeoutError,
  type RowsChoice,
  type RunSettings,
  type TimeoutChoice,
} from "@table-craft/desktop/renderer/model/runSettings.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { useRunSettingsPopover } from "@table-craft/desktop/renderer/state/runSettingsPopover.js";
import { statementTimeoutOf, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import type { SettingsPage } from "@table-craft/desktop/renderer/state/settingsDialog.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

/** What Custom starts at when the default is no timeout at all. */
const FIRST_CUSTOM_TIMEOUT_SECONDS = 30;
const POPOVER_LABEL = "Run settings for this console";
const LINK_CLASS = "text-accent hover:underline";
const NO_TIMEOUT_TEXT = "This data source cannot cancel a statement, so it has no timeout.";

type RowsKind = RowsChoice["kind"];
type TimeoutKind = TimeoutChoice["kind"];

const ROWS_OPTIONS: readonly { readonly kind: RowsKind; readonly label: string }[] = [
  { kind: "default", label: "Default" },
  { kind: "page", label: "Custom" },
  { kind: "all", label: "All" },
];

const TIMEOUT_OPTIONS: readonly { readonly kind: TimeoutKind; readonly label: string }[] = [
  { kind: "default", label: "Default" },
  { kind: "seconds", label: "Custom" },
  { kind: "none", label: "None" },
];

function change(next: Partial<RunSettings>): void {
  void invoke(RUN_SETTINGS_ACTION_IDS.set, next);
}

function openSettings(page: SettingsPage): void {
  useRunSettingsPopover.getState().hide();
  void invoke(SETTINGS_ACTION_IDS.show, { page } satisfies ShowSettingsArgs);
}

/**
 * Radios drawn as one segmented row, as SQL Generator's; the native inputs keep arrow keys and
 * focus, and the enclosing fieldset names the group.
 */
function Choice<K extends string>({
  name,
  options,
  value,
  onPick,
}: {
  readonly name: string;
  readonly options: readonly { readonly kind: K; readonly label: string }[];
  readonly value: K;
  readonly onPick: (kind: K) => void;
}) {
  return (
    <div className="flex self-start rounded border border-line">
      {options.map((option) => (
        <label
          key={option.kind}
          className={cn(
            TEXT_PRESS,
            "flex h-row cursor-default items-center px-gap whitespace-nowrap text-ink first:rounded-l last:rounded-r has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-accent",
            value === option.kind ? "bg-selection ring-1 ring-accent ring-inset" : "hover:bg-raised",
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === option.kind}
            onChange={() => onPick(option.kind)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Note({ children }: { readonly children: ReactNode }) {
  return <p className="whitespace-normal text-ink-muted">{children}</p>;
}

function Warning({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-start gap-1 whitespace-normal text-warning">
      <WarningIcon aria-hidden className="mt-0.5 size-icon shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function keptText(value: string): string {
  return `Runs keep ${value} until it is fixed.`;
}

function RowsGroup({ rows }: { readonly rows: RowsChoice }) {
  const { pageRows, fetchAllCap } = useSettings((state) => state.settings.data);
  return (
    <Group title="Rows">
      <Choice
        name="run-settings-rows"
        options={ROWS_OPTIONS}
        value={rows.kind}
        onPick={(kind) => {
          if (kind === "page") change({ rows: { kind, pageRows } });
          else change({ rows: { kind } });
        }}
      />
      {rows.kind === "default" ? (
        <Note>
          {formatCount(pageRows)} a page, from{" "}
          <button type="button" className={LINK_CLASS} onClick={() => openSettings("dataEditor")}>
            Settings
          </button>
        </Note>
      ) : null}
      {rows.kind === "page" ? (
        <div className={FIELD_GRID_CLASS}>
          <NumberField
            label="Page size"
            value={rows.pageRows}
            range={RUN_ROWS_RANGE}
            check={runRowsError}
            kept={keptText(formatCount(rows.pageRows))}
            onValid={(next) => change({ rows: { kind: "page", pageRows: next } })}
          />
        </div>
      ) : null}
      {rows.kind === "all" ? (
        <Warning>Reads every row, up to the Fetch All limit of {formatCount(fetchAllCap)}.</Warning>
      ) : null}
    </Group>
  );
}

function TimeoutGroup({ consoleId, timeout }: { readonly consoleId: string; readonly timeout: TimeoutChoice }) {
  const datasource = useConsoleDatasource(consoleId);
  // Subscribed so the note follows a change in Settings while the popover is open.
  useSettings((state) => state.settings.console.statementTimeoutSeconds);
  const base = statementTimeoutOf(datasource);
  const fromDatasource = datasource?.statementTimeoutSeconds !== undefined;
  return (
    <Group title="Statement timeout">
      <Choice
        name="run-settings-timeout"
        options={TIMEOUT_OPTIONS}
        value={timeout.kind}
        onPick={(kind) => {
          if (kind === "seconds")
            change({ timeout: { kind, seconds: base > 0 ? base : FIRST_CUSTOM_TIMEOUT_SECONDS } });
          else change({ timeout: { kind } });
        }}
      />
      {timeout.kind === "default" ? (
        <Note>
          {base > 0 ? `${formatCount(base)} s` : "None"}, from{" "}
          {fromDatasource ? (
            "the data source"
          ) : (
            <button type="button" className={LINK_CLASS} onClick={() => openSettings("advanced")}>
              Settings
            </button>
          )}
        </Note>
      ) : null}
      {timeout.kind === "seconds" ? (
        <div className={FIELD_GRID_CLASS}>
          <NumberField
            label="Seconds"
            value={timeout.seconds}
            range={RUN_TIMEOUT_RANGE}
            check={runTimeoutError}
            kept={keptText(`${formatCount(timeout.seconds)} s`)}
            onValid={(seconds) => change({ timeout: { kind: "seconds", seconds } })}
          />
        </div>
      ) : null}
      {timeout.kind === "none" ? <Note>Runs until it ends or you cancel it.</Note> : null}
    </Group>
  );
}

function RunSettingsPopover({
  consoleId,
  session,
  anchor,
  timeouts,
}: {
  readonly consoleId: string;
  readonly session: ConsoleSession;
  readonly anchor: PopoverAnchor;
  readonly timeouts: boolean;
}) {
  const { runSettings } = session;
  return (
    <Popover
      anchor={anchor}
      label={POPOVER_LABEL}
      testId="run-settings"
      onClose={() => useRunSettingsPopover.getState().hide()}
      focusSelf
    >
      <div className="flex w-status-popover max-w-full flex-col gap-gap overflow-y-auto p-gap">
        <RowsGroup rows={runSettings.rows} />
        {timeouts ? (
          <TimeoutGroup consoleId={consoleId} timeout={runSettings.timeout} />
        ) : (
          <Group title="Statement timeout">
            <Note>{NO_TIMEOUT_TEXT}</Note>
          </Group>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-gap border-t border-line px-gap py-1">
        <p className="min-w-0 flex-1 text-ink-muted">For this console only, from its next run.</p>
        <button
          type="button"
          data-testid="run-settings-reset"
          disabled={isDefaultRunSettings(runSettings)}
          className={cn(TEXT_PRESS, "rounded px-1 text-accent enabled:hover:bg-raised disabled:opacity-50")}
          onClick={() => change(DEFAULT_RUN_SETTINGS)}
        >
          Restore Defaults
        </button>
      </div>
    </Popover>
  );
}

/**
 * The console toolbar's gear (plan 141): this console's row limit and statement timeout. A dot
 * marks a console that overrides either, and the tooltip names what.
 */
export function RunSettingsButton({
  consoleId,
  session,
  timeouts,
}: {
  readonly consoleId: string;
  readonly session: ConsoleSession;
  /** Whether the plugin can cancel, without which no timeout is offered (decision 054). */
  readonly timeouts: boolean;
}) {
  const open = useRunSettingsPopover((state) => state.consoleId === consoleId);
  const holder = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const pageRows = useSettings((state) => state.settings.data.pageRows);
  const datasource = useConsoleDatasource(consoleId);
  useSettings((state) => state.settings.console.statementTimeoutSeconds);
  const own: RunSettings = timeouts ? session.runSettings : { ...session.runSettings, timeout: { kind: "default" } };
  const summary = runSettingsSummary(
    effectiveRunSettings(own, { pageRows, timeoutSeconds: statementTimeoutOf(datasource) }),
  );

  useLayoutEffect(() => {
    if (!open || holder.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = holder.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);

  return (
    <>
      <span
        ref={holder}
        data-testid="run-settings-button"
        data-overridden={summary === null ? undefined : ""}
        className="relative flex shrink-0"
        // The popover closes on a press outside it; the gear's own press must leave that to its click.
        onPointerDown={open ? (event) => event.stopPropagation() : undefined}
      >
        <ActionButton
          actionId={RUN_SETTINGS_ACTION_IDS.show}
          compact
          expanded={open}
          {...(summary === null ? {} : { hint: `Run Settings: ${summary}`, label: `Run Settings… (${summary})` })}
        />
        {summary === null ? null : (
          <span
            aria-hidden
            data-testid="run-settings-dot"
            className="pointer-events-none absolute top-0 right-0 size-2 rounded-full bg-accent"
          />
        )}
      </span>
      {open && anchor !== null ? (
        <RunSettingsPopover consoleId={consoleId} session={session} anchor={anchor} timeouts={timeouts} />
      ) : null}
    </>
  );
}
