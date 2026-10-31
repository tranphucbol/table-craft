import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useState, type ReactNode } from "react";
import { WINDOW_STYLES, type DensityId, type WindowStyle } from "@table-craft/desktop/appearance/themes.js";
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
  DialogCloseButton,
  FIELD_GRID_CLASS,
  FieldRow,
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
import { Dropdown, type DropdownOption } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { installedFontFamilies, type FontFamilies } from "@table-craft/desktop/renderer/settings/fonts.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import {
  SETTINGS_PAGES,
  TOOLS_GROUP_START,
  TOOLS_GROUP_TITLE,
  useSettingsDialog,
  type SettingsPage,
} from "@table-craft/desktop/renderer/state/settingsDialog.js";
import { useUpdate } from "@table-craft/desktop/renderer/state/update.js";
import { useWindowState } from "@table-craft/desktop/renderer/state/windowState.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { effectiveChannel } from "@table-craft/desktop/settings/channel.js";
import {
  BRAND_ICON_COLORS,
  type BrandIconColor,
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
  WATCH_RETENTION_RANGE,
  watchRetentionError,
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

const WINDOW_STYLE_LABELS: Readonly<Record<WindowStyle, string>> = {
  islands: "Islands",
  classic: "Classic",
};

const BRAND_ICON_COLOR_LABELS: Readonly<Record<BrandIconColor, string>> = {
  brand: "Brand colours",
  gray: "Gray",
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

/** The dropdown value standing for the built-in stack, which no installed family can be named. */
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
      windowStyle: DEFAULT_SETTINGS.appearance.windowStyle,
      fonts: { ...current.appearance.fonts, ui: DEFAULT_SETTINGS.appearance.fonts.ui },
      systemTitleBar: DEFAULT_SETTINGS.appearance.systemTitleBar,
      brandIcons: DEFAULT_SETTINGS.appearance.brandIcons,
      brandIconColor: DEFAULT_SETTINGS.appearance.brandIconColor,
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

function familyOptions(group: string, families: readonly string[]): DropdownOption[] {
  return families.map((family) => ({ value: family, label: family, group }));
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
  const monospace = familyOptions("Monospace", families.monospace);
  const proportional = familyOptions("Proportional", families.proportional);
  const options: DropdownOption[] = [
    { value: BUILT_IN_FAMILY, label: "Built-in" },
    ...(family !== null && !listed.includes(family) ? [{ value: family, label: `${family} (not installed)` }] : []),
    ...(monospaceFirst ? [...monospace, ...proportional] : [...proportional, ...monospace]),
  ];
  return (
    <Dropdown
      id={id}
      label={FONT_LABELS[role]}
      variant="field"
      className="flex-1"
      value={family ?? BUILT_IN_FAMILY}
      options={options}
      onChange={(chosen) => onChange(chosen === BUILT_IN_FAMILY ? null : chosen)}
    />
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
      <SectionTitle>Data sources</SectionTitle>
      <BrandIconsField />
      <BrandIconColorField />
      <SectionTitle>Window</SectionTitle>
      <WindowStyleField />
      <TitleBarField />
    </>
  );
}

/** Islands draws each pane as a card on the window frame, as JetBrains' 2025.3 look does (decision 141). */
function WindowStyleField() {
  const windowStyle = useSettings((state) => state.settings.appearance.windowStyle);
  return (
    <FieldRow label="Style">
      <div role="radiogroup" aria-label="Window style" className="flex gap-gap">
        {WINDOW_STYLES.map((style) => (
          <label key={style} className="flex items-center gap-1">
            <input
              type="radio"
              name="windowStyle"
              checked={windowStyle === style}
              onChange={() =>
                update((current) => ({ ...current, appearance: { ...current.appearance, windowStyle: style } }))
              }
            />
            {WINDOW_STYLE_LABELS[style]}
          </label>
        ))}
      </div>
    </FieldRow>
  );
}

function BrandIconsField() {
  const brandIcons = useSettings((state) => state.settings.appearance.brandIcons);
  const id = useId();
  return (
    <FieldRow label="Icons" htmlFor={id}>
      <label className="flex items-center gap-cell">
        <input
          id={id}
          type="checkbox"
          checked={brandIcons}
          onChange={(event) => {
            const checked = event.target.checked;
            update((current) => ({ ...current, appearance: { ...current.appearance, brandIcons: checked } }));
          }}
        />
        Show database logos on data sources
      </label>
    </FieldRow>
  );
}

function BrandIconColorField() {
  const brandIcons = useSettings((state) => state.settings.appearance.brandIcons);
  const brandIconColor = useSettings((state) => state.settings.appearance.brandIconColor);
  return (
    <FieldRow label="Logo colour">
      <div role="radiogroup" aria-label="Logo colour" className="flex gap-gap">
        {BRAND_ICON_COLORS.map((color) => (
          <label key={color} className={cn("flex items-center gap-1", brandIcons ? undefined : "text-ink-muted")}>
            <input
              type="radio"
              name="brandIconColor"
              disabled={!brandIcons}
              checked={brandIconColor === color}
              onChange={() =>
                update((current) => ({ ...current, appearance: { ...current.appearance, brandIconColor: color } }))
              }
            />
            {BRAND_ICON_COLOR_LABELS[color]}
          </label>
        ))}
      </div>
    </FieldRow>
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
        The title bar changes after a restart.
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
        <Dropdown
          id={styleId}
          label="Style"
          variant="field"
          className="w-28"
          value={format.style}
          options={FORMAT_STYLES.map((style) => ({ value: style, label: FORMAT_STYLE_LABELS[style] }))}
          onChange={(value) => {
            const chosen = FORMAT_STYLES.find((style) => style === value);
            if (chosen !== undefined) setFormat({ style: chosen });
          }}
        />
      </FieldRow>
      <FieldRow label="Keyword case" htmlFor={caseId}>
        <Dropdown
          id={caseId}
          label="Keyword case"
          variant="field"
          className="w-28"
          value={format.keywordCase}
          options={KEYWORD_CASES.map((keywordCase) => ({
            value: keywordCase,
            label: KEYWORD_CASE_LABELS[keywordCase],
          }))}
          onChange={(value) => {
            const chosen = KEYWORD_CASES.find((keywordCase) => keywordCase === value);
            if (chosen !== undefined) setFormat({ keywordCase: chosen });
          }}
        />
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
        <Dropdown
          id={id}
          label="When a statement fails"
          variant="field"
          className="w-40"
          value={onError}
          options={RUN_ALL_ON_ERROR_CHOICES.map((choice) => ({
            value: choice,
            label: RUN_ALL_ON_ERROR_LABELS[choice],
          }))}
          onChange={(value) => {
            const runAllOnError = RUN_ALL_ON_ERROR_CHOICES.find((choice) => choice === value);
            if (runAllOnError === undefined) return;
            update((current) => ({ ...current, console: { ...current.console, runAllOnError } }));
          }}
        />
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
  const stripeId = useId();
  const groupId = useId();
  const jsonId = useId();
  const setData = (patch: Partial<Settings["data"]>) =>
    update((current) => ({ ...current, data: { ...current.data, ...patch } }));
  return (
    <>
      <SectionTitle>Font</SectionTitle>
      <FontFields role="grid" />
      <SectionTitle>Display</SectionTitle>
      <NullTextField />
      <FieldRow label="Rows" htmlFor={stripeId}>
        <label className="flex items-center gap-cell">
          <input
            id={stripeId}
            type="checkbox"
            checked={data.stripedRows}
            onChange={(event) => setData({ stripedRows: event.target.checked })}
          />
          Striped rows
        </label>
      </FieldRow>
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
      <FieldRow label="JSON" htmlFor={jsonId}>
        <label className="flex items-center gap-cell">
          <input
            id={jsonId}
            type="checkbox"
            checked={data.detectJson}
            onChange={(event) => setData({ detectJson: event.target.checked })}
          />
          Detect JSON in text values
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        The value panel shows a text value holding a JSON object or array formatted; {"{}"} switches it.
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
      <SectionTitle>Watch</SectionTitle>
      <NumberField
        label="Events retained per watch"
        value={data.watchRetention}
        range={WATCH_RETENTION_RANGE}
        check={watchRetentionError}
        onValid={(watchRetention) => setData({ watchRetention })}
      />
      <p className="col-start-2 text-ink-muted">
        Applies to new watches. Older display events are dropped at this cap; server gaps are reported separately.
      </p>
    </>
  );
}

function AdvancedPage() {
  const level = useSettings((state) => state.settings.log.level);
  const checkAutomatically = useSettings((state) => state.settings.updates.checkAutomatically);
  const channel = useSettings((state) => state.settings.updates.channel);
  const appVersion = useUpdate((store) => store.state.current);
  const debugId = useId();
  const updatesId = useId();
  const betaId = useId();
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
              update((current) => ({
                ...current,
                updates: { ...current.updates, checkAutomatically: event.target.checked },
              }))
            }
          />
          Check for updates automatically
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        Looks once after launch and then every 2 hours. Nothing downloads or installs until you click Update in the
        toolbar.
      </p>
      <FieldRow label="Beta versions" htmlFor={betaId}>
        <label className="flex items-center gap-cell">
          <input
            id={betaId}
            type="checkbox"
            data-testid="settings-beta-channel"
            checked={effectiveChannel(channel, appVersion) === "beta"}
            onChange={(event) =>
              update((current) => ({
                ...current,
                updates: { ...current.updates, channel: event.target.checked ? "beta" : "stable" },
              }))
            }
          />
          Get beta versions
        </label>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        Betas come before each release and may have rough edges; plugins follow the same choice. Turning this off keeps
        the beta you have until a newer release is out.
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
                    className="mt-1 flex h-row items-end border-t border-line px-cell text-label font-semibold text-ink-muted"
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
              autoFocus={id === page}
              className={cn(
                "flex h-row items-center rounded px-cell text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
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
          className={cn(FIELD_GRID_CLASS, "min-h-0 min-w-0 flex-1 content-start overflow-y-auto p-gap")}
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
          <DialogCloseButton dialog="Settings" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
