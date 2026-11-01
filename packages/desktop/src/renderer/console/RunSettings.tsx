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
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

/** What Custom starts at when the default is no timeout at all. */
const FIRST_CUSTOM_TIMEOUT_SECONDS = 30;
const POPOVER_LABEL = "Run settings for this console";
const LINK_CLASS = "text-accent hover:underline";

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

/** Radios drawn as one segmented row; the native inputs keep arrow keys and focus. */
function Choice<K extends string>({
  name,
  label,
  options,
  value,
  onPick,
}: {
  readonly name: string;
  readonly label: string;
  readonly options: readonly { readonly kind: K; readonly label: string }[];
  readonly value: K;
  readonly onPick: (kind: K) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded border border-line bg-panel p-px">
      {options.map((option) => (
        <label
          key={option.kind}
          className={cn(
            TEXT_PRESS,
            "flex h-row flex-1 cursor-default items-center justify-center rounded px-gap whitespace-nowrap has-focus-visible:outline-2 has-focus-visible:outline-accent",
            value === option.kind ? "bg-selection text-ink" : "text-ink-muted hover:bg-raised hover:text-ink",
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

function Note({ tone, children }: { readonly tone?: "warning"; readonly children: ReactNode }) {
  return <p className={cn("whitespace-normal", tone === "warning" ? "text-warning" : "text-ink-muted")}>{children}</p>;
}

function RowsGroup({ rows }: { readonly rows: RowsChoice }) {
  const { pageRows, fetchAllCap } = useSettings((state) => state.settings.data);
  return (
    <Group title="Rows">
      <Choice
        name="run-settings-rows"
        label="Rows"
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
            label="Rows a page"
            value={rows.pageRows}
            range={RUN_ROWS_RANGE}
            check={runRowsError}
            onValid={(next) => change({ rows: { kind: "page", pageRows: next } })}
          />
        </div>
      ) : null}
      {rows.kind === "all" ? (
        <Note tone="warning">Reads every row, up to the Fetch All limit of {formatCount(fetchAllCap)}.</Note>
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
        label="Statement timeout"
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
    >
      <div className="flex w-status-popover max-w-full flex-col gap-gap overflow-y-auto p-gap">
        <p className="text-ink-muted">For this console only, from its next run.</p>
        <RowsGroup rows={runSettings.rows} />
        {timeouts ? <TimeoutGroup consoleId={consoleId} timeout={runSettings.timeout} /> : null}
      </div>
      <div className="flex shrink-0 justify-end border-t border-line bg-panel px-gap py-1">
        <button
          type="button"
          data-testid="run-settings-reset"
          disabled={isDefaultRunSettings(runSettings)}
          className={cn(TEXT_PRESS, "rounded px-1 text-accent enabled:hover:bg-raised disabled:opacity-50")}
          onClick={() => change(DEFAULT_RUN_SETTINGS)}
        >
          Reset to Defaults
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
  const shown: RunSettings = timeouts ? session.runSettings : { ...session.runSettings, timeout: { kind: "default" } };
  const summary = runSettingsSummary(shown);

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
          pressed={open}
          {...(summary === null ? {} : { hint: `Run Settings: ${summary}` })}
        />
        {summary === null ? null : (
          <span
            aria-hidden
            data-testid="run-settings-dot"
            className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent"
          />
        )}
      </span>
      {open && anchor !== null ? (
        <RunSettingsPopover consoleId={consoleId} session={session} anchor={anchor} timeouts={timeouts} />
      ) : null}
    </>
  );
}
