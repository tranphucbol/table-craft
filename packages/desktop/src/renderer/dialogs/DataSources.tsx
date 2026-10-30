import * as Dialog from "@radix-ui/react-dialog";
import { useId, useMemo, useRef, useState } from "react";
import {
  probeSeenOf,
  type ProbeResult,
  type ServerTimeout,
  type SshHop,
  type TlsHop,
} from "@table-craft/desktop/engine/protocol.js";
import {
  DATASOURCE_COLORS,
  type BridgeFailure,
  type Brand,
  type ConnectionField,
  type DatasourceView,
  type PluginInfo,
  type SecretMode,
} from "@table-craft/desktop/preload/bridge.js";
import { AGENT_ACCESS_LABELS, AGENT_ACCESS_LEVELS } from "@table-craft/desktop/settings/mcp.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { deleteDatasource } from "@table-craft/desktop/renderer/actions/datasourceCommands.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import {
  Button,
  CONTENT_CLASS,
  FieldRow,
  OVERLAY_CLASS,
  Select,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { PluginPicker } from "@table-craft/desktop/renderer/dialogs/PluginPicker.js";
import { EndpointConnection, EndpointTls } from "@table-craft/desktop/renderer/dialogs/EndpointConnection.js";
import { SECRET_MODE_LABEL, SecretField } from "@table-craft/desktop/renderer/dialogs/SecretField.js";
import { SshSection } from "@table-craft/desktop/renderer/dialogs/SshSection.js";
import {
  applyParsedUrl,
  caFileNote,
  draftFromView,
  draftProblems,
  duplicateDraft,
  fieldVisible,
  newDraft,
  offersSshTunnel,
  tlsFieldsOf,
  toSaveRequest,
  type FormDraft,
} from "@table-craft/desktop/renderer/model/datasourceForm.js";
import { serverLimitText, serverTimeoutText } from "@table-craft/desktop/renderer/model/format.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import {
  connectionFieldHelp,
  connectionFieldVisible,
  endpointTestDrafts,
  offersEndpointConnection,
} from "@table-craft/desktop/renderer/model/datasourceConnection.js";
import { folderPaths } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { useDataSourcesDialog, type DialogTarget } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { DatasourceGlyph, useDatasourceBrand } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { ACTION_ICONS, ReadOnlyIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { MissingPlugin } from "@table-craft/desktop/renderer/ui/MissingPlugin.js";
import { TINT_SWATCH } from "@table-craft/desktop/renderer/ui/tint.js";

const NEW_KEY_PREFIX = "new-";
const KEEPALIVE_HINT =
  "Seconds the connection may sit idle before TCP keepalive checks start. 0 turns them off. Blank is 30.";
const TIMEOUT_HINT =
  "A console statement that runs longer is cancelled. 0 waits forever. Blank follows Settings → Editor → Running.";
const NO_SERVER_TIMEOUT_HINT = "This data source's plugin cannot ask the database to stop statements.";
const URL_SEPARATOR = "://";
const READ_ONLY_HINT = "A guard against accidents, not a security boundary: use a read-only database user for that.";
const AGENT_ACCESS_OPTIONS = AGENT_ACCESS_LEVELS.map((value) => ({ value, label: AGENT_ACCESS_LABELS[value] }));
const AGENT_READ_ONLY_NOTE = "Read only while Read-only is on";
const AGENT_ACCESS_HINT =
  "What MCP clients may do here while Settings → MCP Server is on. Ask before reads shows each query that returns rows in the MCP status chip for you to allow or deny, and refuses writes. Ask before writes does the same for each write. Agents never see passwords.";
const CLIENT_CN_NOTE = "Signs in with the client certificate set under SSL.";
const CLIENT_CN_HINT =
  "etcd takes the user name from the certificate's CN, so no user name or password is needed. TableCraft does not read the certificate, so it cannot show the CN here.";
const AUTO_AUTH_HINT =
  "Signs in with the user name and password when you fill them in. Pick a mode to require a password or a client certificate.";

type TestState =
  | { readonly kind: "testing" }
  | { readonly kind: "done"; readonly result: ProbeResult; readonly endpoints: readonly ProbeResult[] };

/** "SSH: connected to bastion as deploy · 12 ms", the first hop Test Connection reports (decision 070). */
export function sshHopSummary(hop: SshHop): string {
  return `SSH: connected to ${hop.host} as ${hop.user} · ${String(Math.round(hop.elapsedMs))} ms`;
}

/** "SSL: TLSv1.3 · TLS_AES_256_GCM_SHA384", or that the connection is not encrypted (decision 072). */
export function tlsSummary(tls: TlsHop | null): string {
  return tls === null ? "SSL: not encrypted" : `SSL: ${tls.protocol} · ${tls.cipher}`;
}

/** "Succeeded · PostgreSQL 17.4 · 38 ms" (plan 004), naming the product that answered among `brands`. */
export function testSummary(result: Extract<ProbeResult, { ok: true }>, brands: readonly Brand[] = []): string {
  const product = brands.find((brand) => brand.id === result.serverBrand)?.name ?? result.pluginName;
  const server = result.serverVersion === null ? product : `${product} ${result.serverVersion}`;
  const limit =
    result.serverTimeout === undefined || result.serverTimeout === null
      ? ""
      : ` · ${serverLimitText(result.serverTimeout)}`;
  return `Succeeded · ${server}${limit} · ${String(Math.round(result.elapsedMs))} ms`;
}

interface EditorState {
  /** Drafts the user touched, by key; untouched datasources are read from the store. */
  readonly edits: Readonly<Record<string, FormDraft>>;
  /** Keys of drafts not saved yet, in the order they were added. */
  readonly added: readonly string[];
  readonly selected: string | null;
  readonly choosingPlugin: boolean;
}

let draftsCreated = 0;
function nextKey(): string {
  return `${NEW_KEY_PREFIX}${String(draftsCreated++)}`;
}

function initialState(
  target: DialogTarget,
  datasources: readonly DatasourceView[],
  plugins: readonly PluginInfo[],
  defaultMode: SecretMode,
): EditorState {
  const names = datasources.map((datasource) => datasource.name);
  if (target.kind === "edit") {
    const selected = target.id ?? datasources[0]?.id ?? null;
    return { edits: {}, added: [], selected, choosingPlugin: selected === null };
  }
  if (target.kind === "duplicate") {
    const source = datasources.find((datasource) => datasource.id === target.id);
    if (source === undefined) return { edits: {}, added: [], selected: null, choosingPlugin: true };
    const draft = duplicateDraft(nextKey(), source, pluginOf(plugins, source.pluginId), names, defaultMode);
    return { edits: { [draft.key]: draft }, added: [draft.key], selected: draft.key, choosingPlugin: false };
  }
  const plugin = target.pluginId === null ? undefined : pluginOf(plugins, target.pluginId);
  if (plugin === undefined) return { edits: {}, added: [], selected: null, choosingPlugin: true };
  const draft = newDraft(nextKey(), plugin, names, defaultMode, target.folder);
  return { edits: { [draft.key]: draft }, added: [draft.key], selected: draft.key, choosingPlugin: false };
}

interface FieldProps {
  readonly field: ConnectionField;
  readonly draft: FormDraft;
  readonly encryption: { readonly available: boolean; readonly reason: string | null };
  readonly onChange: (change: Partial<FormDraft>) => void;
  /** Takes text pasted into the field when it is a connection URL; false leaves the paste alone. */
  readonly onPasteUrl: (field: ConnectionField, text: string) => boolean;
  readonly plugin?: PluginInfo;
}

function PlainField({ field, draft, onChange, onPasteUrl, hint }: FieldProps & { readonly hint?: string | null }) {
  const id = useId();
  const value = draft.values[field.key];
  const set = (next: string | boolean) => onChange({ values: { ...draft.values, [field.key]: next } });
  if (field.kind === "checkbox") {
    return (
      <FieldRow label={field.label} htmlFor={id} hint={hint}>
        <input id={id} type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
      </FieldRow>
    );
  }
  const text = typeof value === "string" ? value : "";
  if (field.kind === "select") {
    return (
      <FieldRow label={field.label} htmlFor={id} hint={hint}>
        <Dropdown
          id={id}
          label={field.label}
          variant="field"
          value={text}
          options={[...(field.required === true ? [] : [{ value: "", label: "—" }]), ...(field.options ?? [])]}
          onChange={set}
        />
      </FieldRow>
    );
  }
  return (
    <FieldRow label={field.label} htmlFor={id} hint={hint}>
      <TextInput
        id={id}
        className={field.kind === "number" ? "w-24" : "flex-1"}
        inputMode={field.kind === "number" ? "numeric" : undefined}
        placeholder={field.placeholder}
        value={text}
        onChange={(event) => set(event.target.value)}
        onPaste={(event) => {
          if (onPasteUrl(field, event.clipboardData.getData("text"))) event.preventDefault();
        }}
      />
      {field.kind === "file" ? (
        <Button
          onClick={() => {
            void bridge()
              .chooseFile(field.label)
              .then((chosen) => {
                if (chosen.ok && chosen.value !== null) set(chosen.value);
              });
          }}
        >
          Browse…
        </Button>
      ) : null}
    </FieldRow>
  );
}

function Fields(props: Omit<FieldProps, "field"> & { readonly fields: readonly ConnectionField[] }) {
  const { fields, ...rest } = props;
  return fields
    .filter((field) => fieldVisible(field, rest.draft) && connectionFieldVisible(field, rest.draft, rest.plugin))
    .map((field) =>
      field.secret === true ? (
        <SecretField key={field.key} field={field} {...rest} />
      ) : (
        <ConnectionPlainField key={field.key} field={field} {...rest} />
      ),
    );
}

function ConnectionPlainField(props: FieldProps) {
  if (!offersEndpointConnection(props.plugin)) return <PlainField {...props} />;
  if (props.field.key !== "authMode") return <PlainField {...props} hint={connectionFieldHelp(props.field.key)} />;
  const mode = props.draft.values.authMode;
  return (
    <>
      <PlainField {...props} hint={mode === "auto" ? AUTO_AUTH_HINT : mode === "clientCN" ? CLIENT_CN_HINT : null} />
      {mode === "clientCN" ? <p className="col-start-2 text-ink-muted">{CLIENT_CN_NOTE}</p> : null}
    </>
  );
}

/** Whether pasted text is one of the plugin's URLs rather than a host name or a plain path. */
export function looksLikeUrl(spec: NonNullable<PluginInfo["url"]>, text: string): boolean {
  const lower = text
    .trim()
    .toLowerCase()
    .replace(/^jdbc:/, "");
  return spec.schemes.some((scheme) =>
    spec.form === "server" ? lower.startsWith(`${scheme}${URL_SEPARATOR}`) : lower.startsWith(`${scheme}:`),
  );
}

/** The field a URL part fills; a URL pasted there is read as a whole URL. */
function urlFieldKey(spec: NonNullable<PluginInfo["url"]>): string | undefined {
  return spec.form === "server" ? spec.parts.host : spec.parts.path;
}

function UrlNoteLine({ draft, fields }: { readonly draft: FormDraft; readonly fields: readonly ConnectionField[] }) {
  const note = draft.urlNote;
  if (note === null) return null;
  if (note.kind === "failed") {
    return (
      <p role="alert" data-testid="url-note" className="col-start-2 text-danger">
        {note.message} <span className="text-ink-muted">{note.hint}</span>
      </p>
    );
  }
  const saved = note.secrets.map((label) => {
    const key = fields.find((field) => field.label === label)?.key ?? "";
    const mode = SECRET_MODE_LABEL[draft.secretModes[key] ?? "never"];
    return `${label} from the URL; saved with ${mode}.`;
  });
  const ignored = note.ignored.length === 0 ? [] : [`Ignored: ${note.ignored.join(", ")}.`];
  const lines = [...saved, ...ignored];
  if (lines.length === 0) return null;
  return (
    <p data-testid="url-note" className="col-start-2 text-ink-muted">
      {lines.join(" ")}
    </p>
  );
}

function SectionTitle({ children }: { readonly children: string }) {
  return <h3 className="col-span-2 mt-gap border-b border-line pb-1 font-semibold text-ink-muted">{children}</h3>;
}

function SubsectionTitle({ children }: { readonly children: string }) {
  return <h4 className="col-span-2 mt-1 font-semibold text-ink-muted">{children}</h4>;
}

/** The SSL rows under SSH/SSL: the mode, then the certificate files (decision 072). */
function SslRows(
  props: Omit<FieldProps, "field"> & {
    readonly fields: readonly ConnectionField[];
    readonly plugin: PluginInfo | undefined;
  },
) {
  const { plugin, ...rest } = props;
  const note = caFileNote(props.draft, plugin);
  return (
    <>
      <SubsectionTitle>SSL</SubsectionTitle>
      {offersEndpointConnection(plugin) && plugin !== undefined ? (
        <EndpointTls draft={props.draft} plugin={plugin} onChange={props.onChange} />
      ) : null}
      <Fields {...rest} {...(plugin === undefined ? {} : { plugin })} />
      {note === null ? null : (
        <p data-testid="ca-file-note" className="col-start-2 text-ink-muted">
          {note}
        </p>
      )}
    </>
  );
}

interface FormProps {
  readonly draft: FormDraft;
  readonly plugin: PluginInfo | undefined;
  readonly folders: readonly string[];
  readonly onChange: (change: Partial<FormDraft>) => void;
  readonly onUrl: (url: string) => void;
  readonly endpointTests?: readonly ProbeResult[];
  /** What the last successful Test Connection found; undefined before one. */
  readonly serverTimeout: ServerTimeout | null | undefined;
}

function DraftForm({ draft, plugin, folders, onChange, onUrl, serverTimeout, endpointTests }: FormProps) {
  const encryption = useDatasources((state) => state.encryption);
  const appTimeout = useSettings((state) => state.settings.console.statementTimeoutSeconds);
  const nameId = useId();
  const folderId = useId();
  const commentId = useId();
  const foldersId = useId();
  const urlId = useId();
  const keepAliveId = useId();
  const timeoutId = useId();
  const fields = plugin?.fields ?? [];
  const tlsFields = tlsFieldsOf(plugin);
  const endpointConnection = offersEndpointConnection(plugin);
  const connectionGeneral = ["authMode", "user", "password", "namespace", "namespaceEncoding"];
  const ownFields = fields.filter(
    (field) =>
      !tlsFields.includes(field) &&
      (!endpointConnection ||
        (field.key !== "endpoints" &&
          field.key !== plugin?.network?.host &&
          field.key !== plugin?.network?.port &&
          field.key !== "serverName")),
  );
  const general = endpointConnection
    ? connectionGeneral.flatMap((key) => ownFields.find((field) => field.key === key) ?? [])
    : ownFields.filter((field) => field.group !== "advanced");
  const advanced = endpointConnection
    ? ownFields.filter((field) => !general.includes(field))
    : ownFields.filter((field) => field.group === "advanced");
  const sslFields = endpointConnection
    ? [...tlsFields, ...fields.filter((field) => field.key === "serverName")]
    : tlsFields;
  const tunnel = offersSshTunnel(plugin);
  const spec = plugin?.url ?? null;
  const capabilities = plugin?.capabilities ?? [];
  const keepAlive = capabilities.includes("keepAlive");
  const timeout = capabilities.includes("cancel");
  const enforceable = capabilities.includes("serverTimeout");
  const onPasteUrl = (field: ConnectionField, text: string): boolean => {
    if (spec === null || urlFieldKey(spec) !== field.key || !looksLikeUrl(spec, text)) return false;
    onUrl(text);
    return true;
  };
  const fieldProps = { draft, encryption, onChange, onPasteUrl, ...(plugin === undefined ? {} : { plugin }) };
  // Chromium scrolls a fieldset through an anonymous inner box that misses wheel events over the grid
  // gaps, so a plain div scrolls and the fieldset only lays out and disables.
  return (
    <div data-testid="datasource-form" className="min-h-0 flex-1 overflow-y-auto p-gap">
      <fieldset
        disabled={draft.ephemeral}
        className="grid min-w-0 grid-cols-[8rem_1fr] content-start items-center gap-x-gap gap-y-1"
      >
        {draft.ephemeral ? (
          <p className="col-span-2 mb-gap text-ink-muted">
            From TABLE_CRAFT_DATASOURCE: not saved, and not editable here. Duplicate it to keep a copy.
          </p>
        ) : null}
        <FieldRow label="Name" htmlFor={nameId}>
          <TextInput
            id={nameId}
            className="flex-1"
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </FieldRow>
        <FieldRow label="Folder" htmlFor={folderId}>
          <TextInput
            id={folderId}
            className="flex-1"
            list={foldersId}
            placeholder="Docker/Main"
            value={draft.folder}
            onChange={(event) => onChange({ folder: event.target.value })}
          />
          <datalist id={foldersId}>
            {folders.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
        </FieldRow>
        <FieldRow label="Comment" htmlFor={commentId}>
          <TextInput
            id={commentId}
            className="flex-1"
            value={draft.comment}
            onChange={(event) => onChange({ comment: event.target.value })}
          />
        </FieldRow>
        <SectionTitle>General</SectionTitle>
        {spec === null ? null : (
          <>
            <FieldRow label="URL" htmlFor={urlId}>
              <TextInput
                id={urlId}
                className="flex-1"
                placeholder={`Paste a ${spec.schemes[0] ?? ""}${spec.form === "server" ? URL_SEPARATOR : ":"} URL to fill the fields`}
                value={draft.url}
                onChange={(event) => onChange({ url: event.target.value, urlNote: null })}
                onPaste={(event) => {
                  event.preventDefault();
                  onUrl(event.clipboardData.getData("text"));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && draft.url.trim() !== "") onUrl(draft.url);
                }}
              />
            </FieldRow>
            <UrlNoteLine draft={draft} fields={fields} />
          </>
        )}
        {endpointConnection && plugin !== undefined ? (
          <EndpointConnection
            draft={draft}
            plugin={plugin}
            onChange={onChange}
            {...(endpointTests === undefined ? {} : { endpointTests })}
          />
        ) : null}
        <Fields fields={general} {...fieldProps} />
        {draft.ephemeral || encryption.available ? null : (
          <p className="col-span-2 text-ink-muted">Forever is unavailable: {encryption.reason}</p>
        )}
        {tunnel || tlsFields.length > 0 ? (
          <>
            <SectionTitle>SSH/SSL</SectionTitle>
            {tunnel ? <SshSection draft={draft} encryption={encryption} onChange={onChange} /> : null}
            {tlsFields.length > 0 ? <SslRows fields={sslFields} plugin={plugin} {...fieldProps} /> : null}
          </>
        ) : null}
        {advanced.length === 0 && !keepAlive && !timeout ? null : (
          <>
            <SectionTitle>Advanced</SectionTitle>
            <Fields fields={advanced} {...fieldProps} />
            {keepAlive ? (
              <FieldRow label="Keepalive (s)" htmlFor={keepAliveId} hint={KEEPALIVE_HINT}>
                <TextInput
                  id={keepAliveId}
                  className="w-24"
                  inputMode="numeric"
                  placeholder="30"
                  value={draft.keepAliveSeconds}
                  onChange={(event) => onChange({ keepAliveSeconds: event.target.value })}
                />
              </FieldRow>
            ) : null}
            {timeout ? (
              <FieldRow label="Statement timeout (s)" htmlFor={timeoutId} hint={TIMEOUT_HINT}>
                <TextInput
                  id={timeoutId}
                  className="w-24"
                  inputMode="numeric"
                  placeholder={String(appTimeout)}
                  value={draft.statementTimeoutSeconds}
                  onChange={(event) => onChange({ statementTimeoutSeconds: event.target.value })}
                />
              </FieldRow>
            ) : null}
            {timeout ? (
              <FieldRow
                label=""
                hint={enforceable ? serverTimeoutText(serverTimeout) : NO_SERVER_TIMEOUT_HINT}
                hintLabel="About having the database stop it"
                hintTestId="server-timeout-hint"
              >
                <label className={cn("flex min-w-0 items-center gap-cell", !enforceable && "text-ink-muted")}>
                  <input
                    type="checkbox"
                    data-testid="enforce-timeout-on-server"
                    disabled={!enforceable}
                    checked={enforceable && draft.enforceTimeoutOnServer}
                    onChange={(event) => onChange({ enforceTimeoutOnServer: event.target.checked })}
                  />
                  <span>Also have the database stop it</span>
                </label>
              </FieldRow>
            ) : null}
          </>
        )}
        <SectionTitle>Options</SectionTitle>
        <FieldRow label="Read-only" hint={READ_ONLY_HINT}>
          <label className="flex items-center gap-cell">
            <input
              type="checkbox"
              checked={draft.readOnly}
              onChange={(event) => onChange({ readOnly: event.target.checked })}
            />
            <ReadOnlyIcon aria-hidden className="size-icon text-ink-muted" />
            <span className="text-ink-muted">Refuse writes in this data source's sessions</span>
          </label>
        </FieldRow>
        <FieldRow label="AI agent access" hint={AGENT_ACCESS_HINT}>
          <Select
            label="AI agent access"
            testId="datasource-agent-access"
            value={draft.agentAccess}
            options={AGENT_ACCESS_OPTIONS}
            onChange={(value) => {
              const agentAccess = AGENT_ACCESS_LEVELS.find((level) => level === value);
              if (agentAccess !== undefined) onChange({ agentAccess });
            }}
          />
          {draft.readOnly && draft.agentAccess === "ask" ? (
            <span className="truncate text-ink-muted">{AGENT_READ_ONLY_NOTE}</span>
          ) : null}
        </FieldRow>
        <FieldRow label="Colour">
          <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1">
            <button
              type="button"
              role="radio"
              aria-checked={draft.color === null}
              aria-label="No colour"
              className={cn(
                "size-row rounded border border-line text-ink-muted",
                draft.color === null && "outline-2 outline-accent",
              )}
              onClick={() => onChange({ color: null })}
            >
              –
            </button>
            {DATASOURCE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={draft.color === color}
                aria-label={color}
                className={cn("size-row rounded", TINT_SWATCH[color], draft.color === color && "outline-2 outline-ink")}
                onClick={() => onChange({ color })}
              />
            ))}
          </div>
        </FieldRow>
      </fieldset>
    </div>
  );
}

function Editor({ target }: { readonly target: DialogTarget }) {
  const datasources = useDatasources((state) => state.datasources);
  const plugins = useDatasources((state) => state.plugins);
  const catalog = useDatasources((state) => state.catalog);
  const emptyFolders = useDatasources((state) => state.emptyFolders);
  const encryption = useDatasources((state) => state.encryption);
  const defaultMode: SecretMode = encryption.available ? "forever" : "untilRestart";
  const hide = useDataSourcesDialog((state) => state.hide);
  const [state, setState] = useState<EditorState>(() => initialState(target, datasources, plugins, defaultMode));
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({});
  const testGenerations = useRef(new Map<string, number>());
  const [failure, setFailure] = useState<BridgeFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const folders = useMemo(() => folderPaths(datasources, emptyFolders), [datasources, emptyFolders]);

  function draftOf(key: string): FormDraft | undefined {
    const edited = state.edits[key];
    if (edited !== undefined) return edited;
    const view = datasources.find((datasource) => datasource.id === key);
    return view === undefined ? undefined : draftFromView(view, pluginOf(plugins, view.pluginId));
  }

  const listed: readonly FormDraft[] = [
    ...datasources.flatMap((view) => draftOf(view.id) ?? []),
    ...state.added.flatMap((key) => state.edits[key] ?? []),
  ];
  const current = state.choosingPlugin || state.selected === null ? undefined : draftOf(state.selected);
  const plugin = current === undefined ? undefined : pluginOf(plugins, current.pluginId);
  const test = current === undefined ? undefined : tests[current.key];

  function invalidateTest(key: string): number {
    const generation = (testGenerations.current.get(key) ?? 0) + 1;
    testGenerations.current.set(key, generation);
    setTests((previous) => {
      const { [key]: _stale, ...rest } = previous;
      return rest;
    });
    return generation;
  }

  function change(key: string, patch: Partial<FormDraft>): void {
    const draft = draftOf(key);
    if (draft === undefined) return;
    invalidateTest(key);
    setState((previous) => ({ ...previous, edits: { ...previous.edits, [key]: { ...draft, ...patch, dirty: true } } }));
    setFailure(null);
  }

  async function pasteUrl(draft: FormDraft, url: string): Promise<void> {
    const generation = invalidateTest(draft.key);
    const draftPlugin = pluginOf(plugins, draft.pluginId);
    const answer = await bridge().parseDatasourceUrl(draft.pluginId, url);
    if (testGenerations.current.get(draft.key) !== generation) return;
    const next = answer.ok
      ? applyParsedUrl(draft, draftPlugin, answer.value, url)
      : { ...draft, url: url.trim(), urlNote: { kind: "failed" as const, ...answer.error } };
    setState((previous) => ({ ...previous, edits: { ...previous.edits, [draft.key]: { ...next, dirty: true } } }));
    setFailure(null);
  }

  function select(key: string): void {
    setState((previous) => ({ ...previous, selected: key, choosingPlugin: false }));
    setFailure(null);
  }

  function addDraft(draft: FormDraft): void {
    setState((previous) => ({
      edits: { ...previous.edits, [draft.key]: draft },
      added: [...previous.added, draft.key],
      selected: draft.key,
      choosingPlugin: false,
    }));
  }

  const names = listed.map((draft) => draft.name);

  /** Saves one draft; false, with the failure shown, when it could not. */
  async function save(draft: FormDraft): Promise<boolean> {
    const draftPlugin = pluginOf(plugins, draft.pluginId);
    const problem = draftProblems(draft, draftPlugin)[0];
    if (problem !== undefined) {
      select(draft.key);
      setFailure({ message: problem, hint: `Fix it in ${draft.name || "the form"}, then save again.` });
      return false;
    }
    const answer = await bridge().saveDatasource(toSaveRequest(draft, draftPlugin));
    if (!answer.ok) {
      select(draft.key);
      setFailure(answer.error);
      return false;
    }
    const savedId = answer.value.id;
    setState((previous) => {
      const { [draft.key]: _saved, ...edits } = previous.edits;
      return {
        ...previous,
        edits,
        added: previous.added.filter((key) => key !== draft.key),
        selected: previous.selected === draft.key ? savedId : previous.selected,
      };
    });
    return true;
  }

  async function saveAll(close: boolean): Promise<void> {
    setSaving(true);
    try {
      const dirty = close ? listed.filter((draft) => draft.dirty && !draft.ephemeral) : current?.dirty ? [current] : [];
      for (const draft of dirty) if (!(await save(draft))) return;
      if (close) hide();
    } finally {
      setSaving(false);
    }
  }

  async function runTest(draft: FormDraft): Promise<void> {
    const draftPlugin = pluginOf(plugins, draft.pluginId);
    const problem = draftProblems(draft, draftPlugin)[0];
    if (problem !== undefined) {
      setFailure({ message: problem, hint: "Fix the connection fields, then test again." });
      return;
    }
    const generation = invalidateTest(draft.key);
    setTests((previous) => ({ ...previous, [draft.key]: { kind: "testing" } }));
    const probe = async (candidate: FormDraft): Promise<ProbeResult> => {
      const answer = await bridge().testDatasource(toSaveRequest(candidate, draftPlugin));
      return answer.ok ? answer.value : { ok: false, error: { code: "connectionFailed", ...answer.error } };
    };
    const result = await probe(draft);
    const endpoints: ProbeResult[] = [];
    if (offersEndpointConnection(draftPlugin) && draftPlugin !== undefined) {
      for (const target of endpointTestDrafts(draft, draftPlugin)) {
        if (testGenerations.current.get(draft.key) !== generation) return;
        endpoints.push(await probe(target.draft));
      }
    }
    if (testGenerations.current.get(draft.key) !== generation) return;
    setTests((previous) => ({ ...previous, [draft.key]: { kind: "done", result, endpoints } }));
    const saved = datasources.find((datasource) => datasource.id === draft.id);
    if (result.ok && saved !== undefined && !saved.ephemeral && saved.pluginId === draft.pluginId) {
      void bridge().rememberServer(saved.id, probeSeenOf(result, Date.now()));
    }
    const { serverBrand } = result.ok ? result : { serverBrand: null };
    if (serverBrand === null || serverBrand === draft.brand) return;
    // Functional, so fields typed while the test ran are kept.
    setState((previous) => {
      const latest = previous.edits[draft.key] ?? draft;
      return { ...previous, edits: { ...previous.edits, [draft.key]: { ...latest, brand: serverBrand, dirty: true } } };
    });
  }

  async function remove(draft: FormDraft): Promise<void> {
    if (draft.id === undefined) {
      setState((previous) => {
        const { [draft.key]: _removed, ...edits } = previous.edits;
        return { ...previous, edits, added: previous.added.filter((key) => key !== draft.key), selected: null };
      });
      return;
    }
    const view = datasources.find((datasource) => datasource.id === draft.id);
    if (view !== undefined) await deleteDatasource(view);
  }

  const AddIcon = ACTION_ICONS.add;
  const ImportIcon = ACTION_ICONS.import;
  const DuplicateIcon = ACTION_ICONS.duplicate;
  const DeleteIcon = ACTION_ICONS.delete;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Dialog.Title className="shrink-0 border-b border-line px-gap py-cell font-semibold">Data Sources</Dialog.Title>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-dialog-list shrink-0 flex-col border-r border-line">
          <div role="toolbar" aria-label="Data source list" className="flex gap-1 p-1">
            <button
              type="button"
              aria-label="Add data source"
              title="Add data source"
              className="flex size-tab items-center justify-center rounded hover:bg-raised"
              onClick={() => setState((previous) => ({ ...previous, choosingPlugin: true }))}
            >
              <AddIcon aria-hidden className="size-icon" />
            </button>
            <button
              type="button"
              aria-label="Import data sources"
              title="Import from DataGrip or TablePro…"
              className="flex size-tab items-center justify-center rounded hover:bg-raised"
              onClick={() => void invoke(ACTION_IDS.importDatasources)}
            >
              <ImportIcon aria-hidden className="size-icon" />
            </button>
            <button
              type="button"
              aria-label="Duplicate data source"
              title="Duplicate data source"
              disabled={current === undefined}
              className="flex size-tab items-center justify-center rounded hover:bg-raised disabled:opacity-40"
              onClick={() => {
                const view = datasources.find((datasource) => datasource.id === current?.id);
                if (view !== undefined) {
                  addDraft(duplicateDraft(nextKey(), view, pluginOf(plugins, view.pluginId), names, defaultMode));
                }
              }}
            >
              <DuplicateIcon aria-hidden className="size-icon" />
            </button>
            <button
              type="button"
              aria-label="Remove data source"
              title="Remove data source"
              disabled={current === undefined || current.ephemeral}
              className="flex size-tab items-center justify-center rounded hover:bg-raised disabled:opacity-40"
              onClick={() => {
                if (current !== undefined) void remove(current);
              }}
            >
              <DeleteIcon aria-hidden className="size-icon" />
            </button>
          </div>
          <ul role="listbox" aria-label="Data sources" className="min-h-0 flex-1 overflow-y-auto p-1">
            {listed.map((draft) => (
              <li
                key={draft.key}
                role="option"
                aria-selected={draft.key === current?.key}
                className={cn(
                  "flex h-row cursor-default items-center gap-cell rounded px-cell hover:bg-raised",
                  draft.key === current?.key && "bg-selection hover:bg-selection",
                )}
                onClick={() => select(draft.key)}
              >
                <DraftGlyph draft={draft} className="size-icon shrink-0" />
                <span className={cn("truncate", draft.id === undefined && "italic")}>
                  {draft.name || "Unnamed"}
                  {draft.dirty ? " *" : ""}
                </span>
                {draft.color === null ? null : (
                  <span aria-hidden className={cn("size-2.5 shrink-0 rounded-sm", TINT_SWATCH[draft.color])} />
                )}
                {draft.folder === "" ? null : <span className="ml-auto truncate text-ink-muted">{draft.folder}</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {current === undefined ? (
            <PluginPicker
              plugins={plugins}
              catalog={catalog}
              onPick={(picked, brand) => {
                const folder = target.kind === "new" ? target.folder : "";
                addDraft(newDraft(nextKey(), picked, names, defaultMode, folder, brand));
              }}
            />
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-cell border-b border-line px-gap py-1 text-ink-muted">
                <DraftGlyph draft={current} className="size-icon" />
                <DraftProduct draft={current} fallback={plugin?.name ?? current.pluginId} />
                {plugin?.unavailableReason == null ? null : (
                  <span className="text-danger">{plugin.unavailableReason}</span>
                )}
                <MissingPlugin pluginId={current.pluginId} />
              </div>
              <DraftForm
                key={current.key}
                draft={current}
                plugin={plugin}
                folders={folders}
                onChange={(patch) => change(current.key, patch)}
                onUrl={(url) => void pasteUrl(current, url)}
                serverTimeout={test?.kind === "done" && test.result.ok ? test.result.serverTimeout : undefined}
                {...(test?.kind === "done" ? { endpointTests: test.endpoints } : {})}
              />
            </>
          )}
        </div>
      </div>
      {failure === null ? null : (
        <p role="alert" className="shrink-0 border-t border-line px-gap py-1 text-danger">
          {failure.message} <span className="text-ink-muted">{failure.hint}</span>
        </p>
      )}
      <div className="flex shrink-0 items-center gap-gap border-t border-line p-gap">
        <Button
          disabled={current === undefined || current.ephemeral || test?.kind === "testing"}
          onClick={() => {
            if (current !== undefined) void runTest(current);
          }}
        >
          Test Connection
        </Button>
        <TestResult state={test} brands={plugin?.brands} />
        <span className="flex-1" />
        <Button variant="primary" disabled={saving} onClick={() => void saveAll(true)}>
          OK
        </Button>
        <Button onClick={hide}>Cancel</Button>
        <Button disabled={saving || current?.dirty !== true || current.ephemeral} onClick={() => void saveAll(false)}>
          Apply
        </Button>
      </div>
    </div>
  );
}

/** A draft's icon: the logo of the product it is, by its id and stored brand like a tree row. */
function DraftGlyph({ draft, className }: { readonly draft: FormDraft; readonly className: string }) {
  const brand = useDatasourceBrand({ id: draft.id ?? draft.key, pluginId: draft.pluginId, brand: draft.brand });
  return <DatasourceGlyph brand={brand} className={className} />;
}

function DraftProduct({ draft, fallback }: { readonly draft: FormDraft; readonly fallback: string }) {
  const brand = useDatasourceBrand({ id: draft.id ?? draft.key, pluginId: draft.pluginId, brand: draft.brand });
  return <span data-testid="draft-product">{brand?.name ?? fallback}</span>;
}

function TestResult({
  state,
  brands,
}: {
  readonly state: TestState | undefined;
  readonly brands: readonly Brand[] | undefined;
}) {
  if (state === undefined) return null;
  if (state.kind === "testing") return <span className="text-ink-muted">Testing…</span>;
  const { result } = state;
  const hop =
    result.ssh === undefined ? null : (
      <span data-testid="test-hop" className="truncate text-success">
        {sshHopSummary(result.ssh)}
      </span>
    );
  if (result.ok) {
    return (
      <span className="flex min-w-0 flex-col">
        {hop}
        <span data-testid="test-result" data-ok="true" className="truncate text-success">
          {testSummary(result, brands)}
        </span>
        {result.tls === undefined ? null : (
          <span
            data-testid="test-tls"
            className={cn("truncate", result.tls === null ? "text-ink-muted" : "text-success")}
          >
            {tlsSummary(result.tls)}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col">
      {hop}
      <span
        data-testid="test-result"
        data-ok="false"
        className={cn("min-w-0 text-danger", hop === null ? "line-clamp-4" : "line-clamp-3")}
        title={`${result.error.message} ${result.error.hint}`}
      >
        {result.error.message} <span className="text-ink-muted">{result.error.hint}</span>
      </span>
    </span>
  );
}

/** DataGrip's Data Sources and Drivers dialog: the list on the left, the selected one's form on the right. */
export function DataSourcesDialog() {
  const target = useDataSourcesDialog((state) => state.target);
  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) useDataSourcesDialog.getState().hide();
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
          {target === null ? null : <Editor key={JSON.stringify(target)} target={target} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
