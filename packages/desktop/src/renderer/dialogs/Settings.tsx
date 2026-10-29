import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { DensityId } from "@table-craft/desktop/appearance/themes.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { registry } from "@table-craft/desktop/renderer/actions/index.js";
import { LOG_ACTION_IDS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { UPDATE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/updateActions.js";
import { SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { WINDOW_ACTION_IDS } from "@table-craft/desktop/renderer/actions/windowActions.js";
import {
  Button,
  CONTENT_CLASS,
  FieldRow,
  INPUT_CLASS,
  OVERLAY_CLASS,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { InspectionFields } from "@table-craft/desktop/renderer/dialogs/InspectionSettings.js";
import { McpSettingsPage } from "@table-craft/desktop/renderer/dialogs/McpSettings.js";
import { MotionFields } from "@table-craft/desktop/renderer/dialogs/MotionSettings.js";
import { PluginsPage } from "@table-craft/desktop/renderer/dialogs/PluginsPage.js";
import {
  FieldError,
  NumberField,
  SectionTitle,
  update,
  useDraft,
} from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { ThemePicker } from "@table-craft/desktop/renderer/dialogs/ThemePicker.js";
import { installedFontFamilies, type FontFamilies } from "@table-craft/desktop/renderer/settings/fonts.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import {
  SETTINGS_PAGES,
  TOOLS_GROUP_START,
  TOOLS_GROUP_TITLE,
  useSettingsDialog,
  type SettingsPage,
} from "@table-craft/desktop/renderer/state/settingsDialog.js";
import { useWindowState } from "@table-craft/desktop/renderer/state/windowState.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_RANGE,
  EXPORT_STALL_SECONDS_RANGE,
  exportStallSecondsError,
  INDENT_WIDTH_RANGE,
  indentWidthError,
  KEYWORD_CASES,
  LINES_BETWEEN_STATEMENTS_RANGE,
  linesBetweenStatementsError,
  type KeywordCase,
  FETCH_ALL_CAP_RANGE,
  fetchAllCapError,
  fontFamilyError,
  fontSizeError,
  FORMAT_STYLES,
  type FormatStyle,
  nullTextError,
  PAGE_ROWS_RANGE,
  pageRowsError,
  withFont,
  type FontRole,
  type FontSetting,
  RUN_ALL_ON_ERROR_CHOICES,
  type RunAllOnError,
  type Settings,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
  statementTimeoutSecondsError,
  sessionsRefreshSecondsError,
  SESSIONS_REFRESH_SECONDS_RANGE,
} from "@table-craft/desktop/settings/settings.js";

const PAGE_TITLES: Readonly<Record<SettingsPage, string>> = {
  appearance: "Appearance",
  editor: "Editor",
  dataEditor: "Data Editor",
  plugins: "Plugins",
  mcp: "MCP Server",
  advanced: "Advanced",
};

const DENSITY_LABELS: Readonly<Record<DensityId, string>> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

const KEYWORD_CASE_LABELS: Readonly<Record<KeywordCase, string>> = {
  upper: "UPPER",
  lower: "lower",
  preserve: "As typed",
};

const FORMAT_STYLE_LABELS: Readonly<Record<FormatStyle, string>> = {
  aligned: "Aligned",
  standard: "Standard",
};

const FONT_LABELS: Readonly<Record<FontRole, string>> = {
  ui: "UI font",
  editor: "Editor font",
  grid: "Grid font",
};

/** The `<select>` value standing for the built-in stack, which no installed family can be named. */
const BUILT_IN_FAMILY = "";

/** Each page's Restore Defaults puts back only what that page shows. */
const RESTORE: Readonly<Record<SettingsPage, (current: Settings) => Settings>> = {
  appearance: (current) => ({
    ...current,
    appearance: {
      ...current.appearance,
      theme: DEFAULT_SETTINGS.appearance.theme,
      density: DEFAULT_SETTINGS.appearance.density,
      motion: DEFAULT_SETTINGS.appearance.motion,
      fonts: { ...current.appearance.fonts, ui: DEFAULT_SETTINGS.appearance.fonts.ui },
      systemTitleBar: DEFAULT_SETTINGS.appearance.systemTitleBar,
    },
  }),
  editor: (current) => ({
    ...withFont(current, "editor", DEFAULT_SETTINGS.appearance.fonts.editor),
    editor: DEFAULT_SETTINGS.editor,
    console: DEFAULT_SETTINGS.console,
  }),
  dataEditor: (current) => ({
    ...withFont(current, "grid", DEFAULT_SETTINGS.appearance.fonts.grid),
    data: DEFAULT_SETTINGS.data,
  }),
  plugins: (current) => ({ ...current, plugins: DEFAULT_SETTINGS.plugins }),
  mcp: (current) => ({ ...current, mcp: DEFAULT_SETTINGS.mcp }),
  advanced: (current) => ({ ...current, log: DEFAULT_SETTINGS.log }),
};

function useFontFamilies(): FontFamilies | null {
  const [families, setFamilies] = useState<FontFamilies | null>(null);
  useEffect(() => {
    let live = true;
    void installedFontFamilies().then((listed) => {
      if (live) setFamilies(listed);
    });
    return () => {
      live = false;
    };
  }, []);
  return families;
}

function FamilyGroup({ label, families }: { readonly label: string; readonly families: readonly string[] }) {
  if (families.length === 0) return null;
  return (
    <optgroup label={label}>
      {families.map((family) => (
        <option key={family} value={family}>
          {family}
        </option>
      ))}
    </optgroup>
  );
}

function FamilyControl({
  id,
  role,
  family,
  onChange,
}: {
  readonly id: string;
  readonly role: FontRole;
  readonly family: string | null;
  readonly onChange: (family: string | null) => void;
}) {
  const families = useFontFamilies();
  const errorId = useId();
  const { text, edit } = useDraft(family, (value) => value ?? "");
  if (families === null) {
    return <span className="text-ink-muted">Listing fonts…</span>;
  }
  if (families.kind === "unavailable") {
    const error = text === "" ? null : fontFamilyError(text);
    return (
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <TextInput
          id={id}
          className="flex-1"
          placeholder="Built-in"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            const valid = next.trim() === "" || fontFamilyError(next) === null;
            const chosen = next.trim() === "" ? null : next;
            edit(next, valid ? chosen : family);
            if (valid) onChange(chosen);
          }}
        />
        <span className="text-ink-muted">{families.reason} Type a family name; a missing font falls back.</span>
        {error === null ? null : (
          <span id={errorId} role="alert" className="text-danger">
            {error}
          </span>
        )}
      </span>
    );
  }
  const monospaceFirst = role !== "ui";
  const listed = [...families.monospace, ...families.proportional];
  return (
    <select
      id={id}
      className={cn(INPUT_CLASS, "min-w-0 flex-1")}
      value={family ?? BUILT_IN_FAMILY}
      onChange={(event) => onChange(event.target.value === BUILT_IN_FAMILY ? null : event.target.value)}
    >
      <option value={BUILT_IN_FAMILY}>Built-in</option>
      {family !== null && !listed.includes(family) ? <option value={family}>{family} (not installed)</option> : null}
      {monospaceFirst ? (
        <>
          <FamilyGroup label="Monospace" families={families.monospace} />
          <FamilyGroup label="Proportional" families={families.proportional} />
        </>
      ) : (
        <>
          <FamilyGroup label="Proportional" families={families.proportional} />
          <FamilyGroup label="Monospace" families={families.monospace} />
        </>
      )}
    </select>
  );
}

function FontFields({ role }: { readonly role: FontRole }) {
  const font = useSettings((state) => state.settings.appearance.fonts[role]);
  const familyId = useId();
  const set = (next: FontSetting) => update((current) => withFont(current, role, next));
  return (
    <>
      <FieldRow label={FONT_LABELS[role]} htmlFor={familyId}>
        <FamilyControl
          id={familyId}
          role={role}
          family={font.family}
          onChange={(family) => set({ ...useSettings.getState().settings.appearance.fonts[role], family })}
        />
      </FieldRow>
      <NumberField
        label="Size"
        value={font.sizePx}
        range={FONT_SIZE_RANGE}
        check={fontSizeError}
        onValid={(sizePx) => set({ ...useSettings.getState().settings.appearance.fonts[role], sizePx })}
      />
    </>
  );
}

function AppearancePage() {
  const density = useSettings((state) => state.settings.appearance.density);
  return (
    <>
      <SectionTitle>Theme</SectionTitle>
      <div className="col-span-2 flex flex-col gap-1">
        <ThemePicker />
        <div className="flex gap-gap">
          <Button onClick={() => void useSettings.getState().reloadThemes()}>Reload Themes</Button>
          <Button onClick={() => void useSettings.getState().openThemesFolder()}>Open Themes Folder</Button>
        </div>
      </div>
      <SectionTitle>Density</SectionTitle>
      <FieldRow label="Rows">
        <div role="radiogroup" aria-label="Density" className="flex gap-gap">
          {(Object.keys(DENSITY_LABELS) as DensityId[]).map((id) => (
            <label key={id} className="flex items-center gap-1">
              <input
                type="radio"
                name="density"
                checked={density === id}
                onChange={() =>
                  update((current) => ({ ...current, appearance: { ...current.appearance, density: id } }))
                }
              />
              {DENSITY_LABELS[id]}
            </label>
          ))}
        </div>
      </FieldRow>
      <MotionFields />
      <SectionTitle>Font</SectionTitle>
      <FontFields role="ui" />
      <SectionTitle>Window</SectionTitle>
      <TitleBarField />
    </>
  );
}

/** Main reads the choice when it creates the window, so it waits for a restart (plan 015 decision 12). */
function TitleBarField() {
  const systemTitleBar = useSettings((state) => state.settings.appearance.systemTitleBar);
  const customTitleBar = useWindowState((state) => state.customTitleBar);
  const id = useId();
  const pending = systemTitleBar === customTitleBar;
  return (
    <>
      <FieldRow label="Title bar" htmlFor={id}>
        <label className="flex items-center gap-cell">
          <input
            id={id}
            type="checkbox"
            checked={systemTitleBar}
            onChange={(event) => {
              const checked = event.target.checked;
              update((current) => ({ ...current, appearance: { ...current.appearance, systemTitleBar: checked } }));
            }}
          />
          Use system title bar
        </label>
      </FieldRow>
      <div className="col-start-2 flex items-center gap-gap text-ink-muted">
        Takes effect after restart.
        {pending ? <ActionButton actionId={WINDOW_ACTION_IDS.relaunch} /> : null}
      </div>
    </>
  );
}

function chordText(actionId: string): string {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? "" : formatChord(shortcut, currentPlatform());
}

function FormattingFields() {
  const format = useSettings((state) => state.settings.editor.format);
  const styleId = useId();
  const caseId = useId();
  const aliasesId = useId();
  const setFormat = (patch: Partial<Settings["editor"]["format"]>) =>
    update((current) => ({
      ...current,
      editor: { ...current.editor, format: { ...current.editor.format, ...patch } },
    }));
  return (
    <>
      <FieldRow label="Style" htmlFor={styleId}>
        <select
          id={styleId}
          className={cn(INPUT_CLASS, "w-28")}
          value={format.style}
          onChange={(event) => {
            const chosen = FORMAT_STYLES.find((style) => style === event.target.value);
            if (chosen !== undefined) setFormat({ style: chosen });
          }}
        >
          {FORMAT_STYLES.map((style) => (
            <option key={style} value={style}>
              {FORMAT_STYLE_LABELS[style]}
            </option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Keyword case" htmlFor={caseId}>
        <select
          id={caseId}
          className={cn(INPUT_CLASS, "w-28")}
          value={format.keywordCase}
          onChange={(event) => {
            const chosen = KEYWORD_CASES.find((keywordCase) => keywordCase === event.target.value);
            if (chosen !== undefined) setFormat({ keywordCase: chosen });
          }}
        >
          {KEYWORD_CASES.map((keywordCase) => (
            <option key={keywordCase} value={keywordCase}>
              {KEYWORD_CASE_LABELS[keywordCase]}
            </option>
          ))}
        </select>
      </FieldRow>
      <NumberField
        label="Indent width"
        value={format.indentWidth}
        range={INDENT_WIDTH_RANGE}
        check={indentWidthError}
        onValid={(indentWidth) => setFormat({ indentWidth })}
      />
      <NumberField
        label="Blank lines between statements"
        value={format.linesBetweenStatements}
        range={LINES_BETWEEN_STATEMENTS_RANGE}
        check={linesBetweenStatementsError}
        onValid={(linesBetweenStatements) => setFormat({ linesBetweenStatements })}
      />
      <FieldRow label="Align aliases" htmlFor={aliasesId}>
        <label className="flex items-center gap-cell">
          <input
            id={aliasesId}
            type="checkbox"
            checked={format.alignAliases}
            disabled={format.style !== "aligned"}
            onChange={(event) => setFormat({ alignAliases: event.target.checked })}
          />
          Line up AS in a select list
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        {chordText(ACTION_IDS.reformat)} reformats the selection, or the whole console without one.
      </p>
    </>
  );
}

function ParametersField() {
  const parameters = useSettings((state) => state.settings.console.parameters);
  const id = useId();
  return (
    <>
      <FieldRow label="Parameters" htmlFor={id}>
        <label className="flex items-center gap-cell">
          <input
            id={id}
            type="checkbox"
            checked={parameters}
            onChange={(event) => {
              const checked = event.target.checked;
              update((current) => ({ ...current, console: { ...current.console, parameters: checked } }));
            }}
          />
          Ask for :name, ? and $1 values before a run
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">Off, statements go to the server exactly as written.</p>
    </>
  );
}

function StatementTimeoutField() {
  const seconds = useSettings((state) => state.settings.console.statementTimeoutSeconds);
  return (
    <>
      <NumberField
        label="Statement timeout (s)"
        value={seconds}
        range={STATEMENT_TIMEOUT_SECONDS_RANGE}
        check={statementTimeoutSecondsError}
        onValid={(statementTimeoutSeconds) =>
          update((current) => ({ ...current, console: { ...current.console, statementTimeoutSeconds } }))
        }
      />
      <p className="col-start-2 text-ink-muted">
        A console statement running longer is cancelled; 0 waits. A data source can set its own.
      </p>
    </>
  );
}

function SessionsRefreshField() {
  const seconds = useSettings((state) => state.settings.console.sessionsRefreshSeconds);
  return (
    <NumberField
      label="Sessions refresh (s)"
      value={seconds}
      range={SESSIONS_REFRESH_SECONDS_RANGE}
      check={sessionsRefreshSecondsError}
      onValid={(sessionsRefreshSeconds) =>
        update((current) => ({ ...current, console: { ...current.console, sessionsRefreshSeconds } }))
      }
    />
  );
}

const RUN_ALL_ON_ERROR_LABELS: Readonly<Record<RunAllOnError, string>> = {
  ask: "Ask what to do",
  stop: "Stop the run",
  continue: "Skip it and go on",
};

function RunAllOnErrorField() {
  const onError = useSettings((state) => state.settings.console.runAllOnError);
  const id = useId();
  return (
    <>
      <FieldRow label="When a statement fails" htmlFor={id}>
        <select
          id={id}
          className={cn(INPUT_CLASS, "w-40")}
          value={onError}
          onChange={(event) => {
            const runAllOnError = RUN_ALL_ON_ERROR_CHOICES.find((choice) => choice === event.target.value);
            if (runAllOnError === undefined) return;
            update((current) => ({ ...current, console: { ...current.console, runAllOnError } }));
          }}
        >
          {RUN_ALL_ON_ERROR_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {RUN_ALL_ON_ERROR_LABELS[choice]}
            </option>
          ))}
        </select>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        For Run All, a run of several selected statements and Run SQL Script. A lost connection always stops.
      </p>
    </>
  );
}

function EditorPage() {
  return (
    <>
      <SectionTitle>Font</SectionTitle>
      <FontFields role="editor" />
      <p className="col-start-2 text-ink-muted">
        In the console, {chordText(SETTINGS_ACTION_IDS.zoomIn)} enlarges the font,{" "}
        {chordText(SETTINGS_ACTION_IDS.zoomOut)} shrinks it and {chordText(SETTINGS_ACTION_IDS.zoomReset)} restores{" "}
        {DEFAULT_SETTINGS.appearance.fonts.editor.sizePx} px.
      </p>
      <SectionTitle>Formatting</SectionTitle>
      <FormattingFields />
      <SectionTitle>Inspections</SectionTitle>
      <InspectionFields />
      <SectionTitle>Running</SectionTitle>
      <ParametersField />
      <StatementTimeoutField />
    </>
  );
}

function NullTextField() {
  const nullText = useSettings((state) => state.settings.data.nullText);
  const id = useId();
  const errorId = useId();
  const { text, edit } = useDraft(nullText, (value) => value);
  const error = nullTextError(text);
  return (
    <>
      <FieldRow label="NULL text" htmlFor={id}>
        <TextInput
          id={id}
          className="w-28"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            const valid = nullTextError(next) === null;
            edit(next, valid ? next : nullText);
            if (valid) update((current) => ({ ...current, data: { ...current.data, nullText: next } }));
          }}
        />
      </FieldRow>
      <FieldError id={errorId} error={error} />
    </>
  );
}

function DataEditorPage() {
  const data = useSettings((state) => state.settings.data);
  const groupId = useId();
  const setData = (patch: Partial<Settings["data"]>) =>
    update((current) => ({ ...current, data: { ...current.data, ...patch } }));
  return (
    <>
      <SectionTitle>Font</SectionTitle>
      <FontFields role="grid" />
      <SectionTitle>Display</SectionTitle>
      <NullTextField />
      <FieldRow label="Numbers" htmlFor={groupId}>
        <label className="flex items-center gap-cell">
          <input
            id={groupId}
            type="checkbox"
            checked={data.groupDigits}
            onChange={(event) => setData({ groupDigits: event.target.checked })}
          />
          Group digits (1,234,567)
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        Display only: copy, export, filters and the editor keep the database&apos;s text.
      </p>
      <SectionTitle>Paging</SectionTitle>
      <NumberField
        label="Page size"
        value={data.pageRows}
        range={PAGE_ROWS_RANGE}
        check={(pageRows) =>
          pageRowsError(pageRows) ??
          (pageRows > data.fetchAllCap ? "The page size cannot be larger than the Fetch All limit." : null)
        }
        onValid={(pageRows) => setData({ pageRows })}
      />
      <NumberField
        label="Fetch All limit"
        value={data.fetchAllCap}
        range={FETCH_ALL_CAP_RANGE}
        check={(fetchAllCap) => fetchAllCapError(fetchAllCap, data.pageRows)}
        onValid={(fetchAllCap) => setData({ fetchAllCap })}
      />
      <p className="col-start-2 text-ink-muted">Applies to the next statement; open results keep theirs.</p>
      <SectionTitle>Export and import</SectionTitle>
      <NumberField
        label="Transfer stall timeout (s)"
        value={data.exportStallSeconds}
        range={EXPORT_STALL_SECONDS_RANGE}
        check={exportStallSecondsError}
        onValid={(exportStallSeconds) => setData({ exportStallSeconds })}
      />
      <p className="col-start-2 text-ink-muted">
        An export or import the database answers nothing to for this long stops and says so. The statement timeout never
        cuts one.
      </p>
    </>
  );
}

function AdvancedPage() {
  const level = useSettings((state) => state.settings.log.level);
  const checkAutomatically = useSettings((state) => state.settings.updates.checkAutomatically);
  const debugId = useId();
  const updatesId = useId();
  return (
    <>
      <SectionTitle>Log</SectionTitle>
      <FieldRow label="Log level" htmlFor={debugId}>
        <label className="flex items-center gap-cell">
          <input
            id={debugId}
            type="checkbox"
            checked={level === "debug"}
            onChange={(event) =>
              update((current) => ({ ...current, log: { level: event.target.checked ? "debug" : "info" } }))
            }
          />
          Debug logging
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        Also logs every engine request with its timing. Takes effect at once; turn it off when done, the log grows
        faster.
      </p>
      <FieldRow label="Log file">
        <ActionButton actionId={LOG_ACTION_IDS.reveal} />
        <ActionButton actionId={LOG_ACTION_IDS.exportDiagnostics} />
      </FieldRow>
      <SectionTitle>Running</SectionTitle>
      <RunAllOnErrorField />
      <SectionTitle>Sessions</SectionTitle>
      <SessionsRefreshField />
      <SectionTitle>Updates</SectionTitle>
      <FieldRow label="New versions" htmlFor={updatesId}>
        <label className="flex items-center gap-cell">
          <input
            id={updatesId}
            type="checkbox"
            checked={checkAutomatically}
            onChange={(event) =>
              update((current) => ({ ...current, updates: { checkAutomatically: event.target.checked } }))
            }
          />
          Check for updates automatically
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        Looks once after launch and then daily. Nothing downloads or installs until you click Update in the toolbar.
      </p>
      <FieldRow label="Check now">
        <ActionButton actionId={UPDATE_ACTION_IDS.check} />
      </FieldRow>
    </>
  );
}

const PAGES: Readonly<Record<SettingsPage, () => ReactNode>> = {
  appearance: AppearancePage,
  editor: EditorPage,
  dataEditor: DataEditorPage,
  plugins: PluginsPage,
  mcp: McpSettingsPage,
  advanced: AdvancedPage,
};

function SettingsEditor({ page }: { readonly page: SettingsPage }) {
  const notice = useSettings((state) => state.notice);
  const Page = PAGES[page];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Dialog.Title className="shrink-0 border-b border-line px-gap py-cell font-semibold">Settings</Dialog.Title>
      <div className="flex min-h-0 flex-1">
        <div
          role="tablist"
          aria-label="Settings pages"
          aria-orientation="vertical"
          className="flex w-dialog-list shrink-0 flex-col gap-1 border-r border-line p-1"
        >
          {SETTINGS_PAGES.map((id) => [
            ...(id === TOOLS_GROUP_START
              ? [
                  <div
                    key={TOOLS_GROUP_TITLE}
                    role="presentation"
                    className="flex h-row items-end px-cell font-semibold text-ink-muted"
                  >
                    {TOOLS_GROUP_TITLE}
                  </div>,
                ]
              : []),
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === page}
              className={cn(
                "flex h-row items-center rounded px-cell text-left",
                id === page ? "bg-selection" : "hover:bg-raised",
              )}
              onClick={() => useSettingsDialog.getState().show(id)}
            >
              {PAGE_TITLES[id]}
            </button>,
          ])}
        </div>
        <div
          role="tabpanel"
          aria-label={PAGE_TITLES[page]}
          className="grid min-h-0 min-w-0 flex-1 grid-cols-[8rem_1fr] content-start items-center gap-x-gap gap-y-1 overflow-y-auto p-gap"
        >
          <Page />
        </div>
      </div>
      {notice === null ? null : (
        <p role="alert" className="shrink-0 border-t border-line px-gap py-1 text-danger">
          {notice}
        </p>
      )}
      <div className="flex shrink-0 items-center gap-gap border-t border-line p-gap">
        <Button onClick={() => update(RESTORE[page])}>Restore Defaults</Button>
        <span className="flex-1 text-ink-muted">Changes are saved as you make them.</span>
        <Dialog.Close asChild>
          <Button variant="primary">Close</Button>
        </Dialog.Close>
      </div>
    </div>
  );
}

/** DataGrip's Settings (⌘,): pages on the left, the chosen page on the right, saved as changed. */
export function SettingsDialog() {
  const page = useSettingsDialog((state) => state.page);
  return (
    <Dialog.Root
      open={page !== null}
      onOpenChange={(open) => {
        if (!open) useSettingsDialog.getState().hide();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            CONTENT_CLASS,
            "flex h-dialog-height max-h-[95vh] w-dialog max-w-[95vw] flex-col overflow-hidden",
          )}
        >
          {page === null ? null : <SettingsEditor page={page} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
