import { useId, useState } from "react";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS, type AgentPolicyArgs } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { Button, FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { NumberField, SectionTitle, update } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { TimeoutInfo } from "@table-craft/desktop/renderer/dialogs/TimeoutInfo.js";
import { mcpStatusText, MCP_STATE_DOT } from "@table-craft/desktop/renderer/model/mcp.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { Switch } from "@table-craft/desktop/renderer/ui/Switch.js";
import { useCopyConfirmation, COPIED_LABEL } from "@table-craft/desktop/renderer/ui/useCopyConfirmation.js";
import { CloseIcon, InfoIcon, WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_SWATCH } from "@table-craft/desktop/renderer/ui/tint.js";
import {
  AGENT_ACCESS_LABELS,
  AGENT_ACCESS_LEVELS,
  MCP_CLIENT_HINTS,
  MCP_CLIENT_LABELS,
  MCP_CLIENTS,
  mcpClientConfig,
  mcpEndpoint,
  PRODUCTION_COLOR,
  type AgentAccess,
  type McpClient,
  type McpKnownClient,
} from "@table-craft/desktop/settings/mcp.js";
import {
  MCP_PORT_RANGE,
  MCP_ROW_CAP_RANGE,
  MCP_TIMEOUT_SECONDS_RANGE,
  mcpPortError,
  mcpRowCapError,
  mcpTimeoutError,
  type Settings,
} from "@table-craft/desktop/settings/settings.js";

const PRODUCTION_NOTE = "Marked red for production: raise it past Read only on its page in the Data Sources dialog.";
const READ_ONLY_NOTE = "Read-only data source: agents can only read.";
const SCHEMA_SEPARATOR = ",";
const ALL_SHOWN = "All shown";
const ALL_SHOWN_HINT = "Blank keeps the schemas the Database pane shows.";
const SCHEMAS_HINT = "Schemas narrow what agents list and read, not what a statement may name.";
const ROW_CAP_HINT = "Blank keeps the row limit above.";
const TIMEOUT_HINT = "Seconds; blank keeps the statement timeout above.";
const NOT_EXPOSED = "—";
const NAMES = new Intl.ListFormat("en", { type: "conjunction" });
const CELL_CLASS = "h-row px-cell py-1 align-middle";
const HEADER_CLASS = "border-b border-line px-cell pb-1 text-left font-normal text-ink-muted";
const INLINE_INPUT_CLASS =
  "h-row w-full min-w-0 rounded border border-transparent bg-transparent px-1 hover:border-line focus:border-accent focus:outline-none";

/** Why a level is not offered here, or null when it is. */
function lockedReason(datasource: DatasourceView, access: AgentAccess): string | null {
  if (access !== "ask" || datasource.agentAccess === "ask") return null;
  if (datasource.readOnly) return READ_ONLY_NOTE;
  return datasource.color === PRODUCTION_COLOR ? PRODUCTION_NOTE : null;
}

function schemaList(text: string): readonly string[] | null {
  const names = text
    .split(SCHEMA_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return names.length === 0 ? null : names;
}

function setPolicy(datasource: DatasourceView, patch: Partial<AgentPolicyArgs["policy"]>): void {
  const policy = {
    schemas: datasource.agentSchemas ?? null,
    rowCap: datasource.agentRowCap ?? null,
    timeoutSeconds: datasource.agentTimeoutSeconds ?? null,
    ...patch,
  };
  invoke(MCP_ACTION_IDS.setPolicy, { datasourceId: datasource.id, policy } satisfies AgentPolicyArgs);
}

/** Reads as plain text until hovered or focused; saves on Enter or blur, Escape reverts. */
function CommitField({
  label,
  value,
  placeholder,
  title,
  testId,
  className,
  check,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly title: string;
  readonly testId: string;
  readonly className?: string;
  readonly check?: (text: string) => string | null;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const error = draft === null ? null : (check?.(draft) ?? null);
  const commit = () => {
    if (draft === null) return;
    if (error === null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      aria-invalid={error === null ? undefined : true}
      title={error ?? title}
      data-testid={testId}
      className={cn(INLINE_INPUT_CLASS, className, error !== null && "border-danger")}
      value={shown}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape" && draft !== null) {
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

function rowCapCheck(text: string): string | null {
  if (text.trim() === "") return null;
  return mcpRowCapError(Number(text));
}

function timeoutCheck(text: string): string | null {
  if (text.trim() === "") return null;
  return mcpTimeoutError(Number(text));
}

interface AgentDefaults {
  readonly rowCap: number;
  readonly timeoutSeconds: number;
}

/** A red datasource that agents may not ask to write through yet: the warning names it. */
function heldAtReadOnly(datasource: DatasourceView): boolean {
  return datasource.color === PRODUCTION_COLOR && datasource.agentAccess !== "ask";
}

function showProductionNote(shown: boolean): void {
  invoke(MCP_ACTION_IDS.productionNote, shown);
}

function NotExposed({ className }: { readonly className?: string }) {
  return <span className={cn("block px-1 text-ink-muted", className)}>{NOT_EXPOSED}</span>;
}

function AccessRow({
  datasource,
  defaults,
}: {
  readonly datasource: DatasourceView;
  readonly defaults: AgentDefaults;
}) {
  const access = datasource.agentAccess ?? "off";
  const exposed = access !== "off";
  const noteHidden = useLayout((state) => !state.layout.productionNote);
  return (
    <tr data-testid="mcp-access-row" className="even:bg-raised">
      <td className={CELL_CLASS}>
        <span className="flex min-w-0 items-center gap-cell" title={lockedReason(datasource, "ask") ?? undefined}>
          <span
            aria-hidden
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              datasource.color === null ? "border border-ink-muted" : TINT_SWATCH[datasource.color],
            )}
          />
          <span className="min-w-0 truncate">
            {datasource.name} <span className="text-ink-muted">{datasource.pluginId}</span>
          </span>
          {noteHidden && heldAtReadOnly(datasource) ? (
            <button
              type="button"
              aria-label={`Why ${datasource.name} stays at Read only`}
              title={PRODUCTION_NOTE}
              data-testid="mcp-production-note-show"
              className="shrink-0 rounded text-warning hover:bg-raised"
              onClick={() => showProductionNote(true)}
            >
              <InfoIcon aria-hidden className="size-icon" />
            </button>
          ) : null}
        </span>
      </td>
      <td className={CELL_CLASS}>
        <Dropdown
          label={`AI agent access for ${datasource.name}`}
          testId="mcp-access"
          variant="field"
          className="w-full"
          value={access}
          options={AGENT_ACCESS_LEVELS.map((level) => ({
            value: level,
            label: AGENT_ACCESS_LABELS[level],
            disabled: lockedReason(datasource, level) !== null,
          }))}
          onChange={(value) => {
            const chosen = AGENT_ACCESS_LEVELS.find((level) => level === value);
            if (chosen !== undefined) invoke(MCP_ACTION_IDS.setAccess, { datasourceId: datasource.id, access: chosen });
          }}
        />
      </td>
      <td className={CELL_CLASS}>
        {exposed ? (
          <CommitField
            label={`Schemas agents see in ${datasource.name}`}
            testId="mcp-access-schemas"
            title={ALL_SHOWN_HINT}
            className="placeholder:text-ink-muted"
            value={(datasource.agentSchemas ?? []).join(`${SCHEMA_SEPARATOR} `)}
            placeholder={ALL_SHOWN}
            onCommit={(text) => setPolicy(datasource, { schemas: schemaList(text) })}
          />
        ) : (
          <NotExposed />
        )}
      </td>
      <td className={CELL_CLASS}>
        {exposed ? (
          <CommitField
            label={`Row cap for ${datasource.name}`}
            testId="mcp-access-row-cap"
            title={ROW_CAP_HINT}
            className="text-right font-editor tabular-nums placeholder:text-ink"
            value={
              datasource.agentRowCap === undefined || datasource.agentRowCap === null
                ? ""
                : String(datasource.agentRowCap)
            }
            placeholder={String(defaults.rowCap)}
            check={rowCapCheck}
            onCommit={(text) => setPolicy(datasource, { rowCap: text.trim() === "" ? null : Number(text) })}
          />
        ) : (
          <NotExposed className="text-right" />
        )}
      </td>
      <td className={CELL_CLASS}>
        {exposed ? (
          <span className="flex min-w-0 items-center justify-end gap-1">
            <TimeoutInfo datasource={datasource} defaultSeconds={defaults.timeoutSeconds} />
            <span className="w-14 min-w-0">
              <CommitField
                label={`Statement timeout for ${datasource.name}`}
                testId="mcp-access-timeout"
                title={TIMEOUT_HINT}
                className="text-right font-editor tabular-nums placeholder:text-ink"
                value={datasource.agentTimeoutSeconds === undefined ? "" : String(datasource.agentTimeoutSeconds)}
                placeholder={String(defaults.timeoutSeconds)}
                check={timeoutCheck}
                onCommit={(text) => setPolicy(datasource, { timeoutSeconds: text.trim() === "" ? null : Number(text) })}
              />
            </span>
          </span>
        ) : (
          <NotExposed className="text-right" />
        )}
      </td>
    </tr>
  );
}

/** Names the red datasources still held at Read only, so the disabled Ask option is explained once; it can be closed. */
function ProductionNote({ datasources }: { readonly datasources: readonly DatasourceView[] }) {
  const shown = useLayout((state) => state.layout.productionNote);
  const capped = datasources.filter(heldAtReadOnly);
  if (!shown || capped.length === 0) return null;
  return (
    <p
      role="note"
      data-testid="mcp-production-note"
      className="flex items-start gap-cell rounded border border-warning p-cell"
    >
      <WarningIcon aria-hidden className="mt-0.5 size-icon shrink-0 text-warning" />
      <span>
        {NAMES.format(capped.map((datasource) => datasource.name))} {capped.length === 1 ? "is" : "are"} coloured red.
        Red data sources cannot go above <strong>Read only</strong> unless you allow it on its page in the Data Sources
        dialog.
      </span>
      <button
        type="button"
        aria-label="Hide this warning"
        title="Hide this warning; the (i) beside a red data source shows it again"
        data-testid="mcp-production-note-close"
        className="ml-auto shrink-0 rounded text-ink-muted hover:bg-raised hover:text-ink"
        onClick={() => showProductionNote(false)}
      >
        <CloseIcon aria-hidden className="size-icon" />
      </button>
    </p>
  );
}

function AccessTable({ defaults }: { readonly defaults: AgentDefaults }) {
  const all = useDatasources((state) => state.datasources);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const saved = all.filter((datasource) => !datasource.ephemeral);
  const datasources = saved.filter((datasource) => needle === "" || datasource.name.toLowerCase().includes(needle));
  return (
    <div className="col-span-2 flex flex-col gap-cell">
      <p className="text-ink-muted">
        Agents see only what you expose here. New data sources start <strong className="text-ink">Off</strong>.
      </p>
      {saved.length === 0 ? (
        <p className="text-ink-muted">No saved data sources yet.</p>
      ) : (
        <>
          <TextInput
            aria-label="Filter data sources"
            data-testid="mcp-access-filter"
            className="w-48"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <table className="w-full table-fixed border-collapse" aria-label="Data source access">
            <thead>
              <tr>
                <th scope="col" className={HEADER_CLASS}>
                  Data source
                </th>
                <th scope="col" className={cn(HEADER_CLASS, "w-40")}>
                  Access
                </th>
                <th scope="col" className={cn(HEADER_CLASS, "w-32")} title={SCHEMAS_HINT}>
                  Schemas
                </th>
                <th scope="col" className={cn(HEADER_CLASS, "w-24 text-right")}>
                  Row cap
                </th>
                <th scope="col" className={cn(HEADER_CLASS, "w-28 text-right")} title={TIMEOUT_HINT}>
                  Timeout
                </th>
              </tr>
            </thead>
            <tbody>
              {datasources.map((datasource) => (
                <AccessRow key={datasource.id} datasource={datasource} defaults={defaults} />
              ))}
            </tbody>
          </table>
          {datasources.length === 0 ? <p className="text-ink-muted">No data source matches the filter.</p> : null}
          <ProductionNote datasources={saved} />
        </>
      )}
    </div>
  );
}

function ClientSnippet({ port }: { readonly port: number }) {
  const [client, setClient] = useState<McpClient>(MCP_CLIENTS[0]);
  const confirmation = useCopyConfirmation();
  return (
    <>
      <div className="col-span-2 flex items-center gap-1" role="group" aria-label="MCP client">
        {MCP_CLIENTS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === client}
            className={cn("h-row rounded px-gap", id === client ? "bg-selection" : "hover:bg-raised")}
            onClick={() => setClient(id)}
          >
            {MCP_CLIENT_LABELS[id]}
          </button>
        ))}
      </div>
      <pre
        data-testid="mcp-client-config"
        className="col-span-2 rounded border border-line bg-canvas p-cell font-mono wrap-break-word whitespace-pre-wrap"
      >
        {mcpClientConfig(client, port)}
      </pre>
      <div className="col-span-2 flex items-center gap-gap">
        <Button
          data-testid="mcp-copy-config"
          onClick={() => {
            confirmation.arm();
            invoke(MCP_ACTION_IDS.copyConfig, client);
          }}
        >
          {confirmation.copied ? COPIED_LABEL : "Copy with Token"}
        </Button>
        <span className="text-ink-muted">
          {MCP_CLIENT_HINTS[client]} Copy puts the real token where the snippet says.
        </span>
      </div>
    </>
  );
}

function KnownClients({ clients }: { readonly clients: readonly McpKnownClient[] }) {
  if (clients.length === 0)
    return (
      <p className="col-span-2 text-ink-muted">
        No client has asked yet. The first time one connects, the status bar chip turns amber until you allow or block
        it.
      </p>
    );
  return (
    <ul className="col-span-2 flex flex-col" aria-label="Known clients">
      {clients.map((client) => (
        <li key={client.name} className="flex min-w-0 items-center gap-cell py-1" data-testid="mcp-known-client">
          <span className="min-w-0 flex-1 truncate">{client.name}</span>
          <span className={client.allowed ? "text-success" : "text-danger"}>
            {client.allowed ? "Allowed" : "Blocked"}
          </span>
          <Switch
            label={`Allow ${client.name}`}
            testId="mcp-known-client-allowed"
            checked={client.allowed}
            onChange={(allowed) =>
              invoke(MCP_ACTION_IDS.decideClient, { name: client.name, allowed } satisfies McpKnownClient)
            }
          />
          <button
            type="button"
            className="rounded px-1 text-accent hover:bg-raised"
            data-testid="mcp-forget-client"
            onClick={() => invoke(MCP_ACTION_IDS.forgetClient, client.name)}
          >
            Forget
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Settings › MCP Server (plan 117): the server, a client's config, and what agents may do per data source. */
export function McpSettingsPage() {
  const mcp = useSettings((state) => state.settings.mcp);
  const status = useMcp((state) => state.status);
  const enabledId = useId();
  const setMcp = (patch: Partial<Settings["mcp"]>) =>
    update((current) => ({ ...current, mcp: { ...current.mcp, ...patch } }));
  return (
    <>
      <SectionTitle>Server</SectionTitle>
      <FieldRow label="MCP server" htmlFor={enabledId}>
        <span className="flex min-w-0 items-center gap-gap">
          <Switch
            id={enabledId}
            label="Let AI agents reach TableCraft"
            testId="mcp-enabled"
            checked={mcp.enabled}
            onChange={(enabled) => setMcp({ enabled })}
          />
          <span
            data-testid="mcp-state"
            className={cn(
              "flex min-w-0 items-center gap-1",
              status.state === "failed" ? "text-danger" : "text-ink-muted",
            )}
          >
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", MCP_STATE_DOT[status.state])} />
            <span className="truncate">{mcpStatusText(status)}</span>
          </span>
        </span>
      </FieldRow>
      {status.state === "failed" && status.message !== null ? (
        <p role="alert" className="col-start-2 text-danger">
          {status.message}
        </p>
      ) : null}
      <FieldRow label="Endpoint">
        <span className="flex min-w-0 items-center gap-cell">
          <code data-testid="mcp-endpoint" className="min-w-0 truncate font-mono select-text">
            {mcpEndpoint(mcp.port)}
          </code>
          <ActionButton actionId={MCP_ACTION_IDS.copyEndpoint} compact />
        </span>
      </FieldRow>
      <NumberField
        label="Port"
        value={mcp.port}
        range={MCP_PORT_RANGE}
        check={mcpPortError}
        onValid={(port) => setMcp({ port })}
      />
      <p className="col-start-2 text-ink-muted">Listens on this computer only; other machines cannot reach it.</p>
      <FieldRow label="Access token">
        <span className="flex min-w-0 flex-wrap items-center gap-cell">
          <code data-testid="mcp-token-hint" className="font-mono text-ink-muted">
            {status.tokenHint ?? "Made when the server first starts"}
          </code>
          <ActionButton actionId={MCP_ACTION_IDS.copyToken} compact />
          <ActionButton actionId={MCP_ACTION_IDS.regenerateToken} />
        </span>
      </FieldRow>
      <p className="col-start-2 text-ink-muted">Stored encrypted; only its last characters are shown here.</p>
      <NumberField
        label="Row limit"
        value={mcp.rowCap}
        range={MCP_ROW_CAP_RANGE}
        check={mcpRowCapError}
        onValid={(rowCap) => setMcp({ rowCap })}
      />
      <p className="col-start-2 text-ink-muted">
        The most rows one answer shows an agent; it asks for the next ones when it needs them.
      </p>
      <NumberField
        label="Statement timeout"
        value={mcp.statementTimeoutSeconds}
        range={MCP_TIMEOUT_SECONDS_RANGE}
        check={mcpTimeoutError}
        onValid={(statementTimeoutSeconds) => setMcp({ statementTimeoutSeconds })}
      />
      <p className="col-start-2 text-ink-muted">
        Seconds an agent's statement may run. The database stops it there too where it can, even if the app cannot.
      </p>
      <SectionTitle>Connect a client</SectionTitle>
      <ClientSnippet port={mcp.port} />
      <SectionTitle>Clients</SectionTitle>
      <KnownClients clients={mcp.clients} />
      <SectionTitle>Data source access</SectionTitle>
      <AccessTable defaults={{ rowCap: mcp.rowCap, timeoutSeconds: mcp.statementTimeoutSeconds }} />
    </>
  );
}
