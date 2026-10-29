import { useId, useState } from "react";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS, type AgentPolicyArgs } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { Button, FieldRow, INPUT_CLASS, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { NumberField, SectionTitle, update } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { mcpStatusText, MCP_STATE_DOT } from "@table-craft/desktop/renderer/model/mcp.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Switch } from "@table-craft/desktop/renderer/ui/Switch.js";
import { useCopyConfirmation, COPIED_LABEL } from "@table-craft/desktop/renderer/ui/useCopyConfirmation.js";
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
  mcpPortError,
  mcpRowCapError,
  type Settings,
} from "@table-craft/desktop/settings/settings.js";

const PRODUCTION_NOTE = "Marked red for production: raise it past Read only on its page in the Data Sources dialog.";
const READ_ONLY_NOTE = "Read-only data source: agents can only read.";
const SCHEMA_SEPARATOR = ",";
const SHOWN_SCHEMAS = "Shown schemas";
const CELL_CLASS = "py-1 pr-cell align-middle";
const HEADER_CLASS = "pb-1 pr-cell text-left font-normal text-ink-muted";

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
  const policy = { schemas: datasource.agentSchemas ?? null, rowCap: datasource.agentRowCap ?? null, ...patch };
  invoke(MCP_ACTION_IDS.setPolicy, { datasourceId: datasource.id, policy } satisfies AgentPolicyArgs);
}

/** A text field that saves on Enter or when it loses focus, and shows what was saved otherwise. */
function CommitField({
  label,
  value,
  placeholder,
  testId,
  check,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly testId: string;
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
      title={error ?? undefined}
      data-testid={testId}
      className={cn(INPUT_CLASS, "w-full", error !== null && "border-danger")}
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

function AccessRow({ datasource, rowCap }: { readonly datasource: DatasourceView; readonly rowCap: number }) {
  const pluginName = useDatasources(
    (state) => pluginOf(state.plugins, datasource.pluginId)?.name ?? datasource.pluginId,
  );
  const access = datasource.agentAccess ?? "off";
  const note = lockedReason(datasource, "ask");
  const shown = datasource.shownNamespaces ?? [];
  return (
    <tr data-testid="mcp-access-row">
      <td className={CELL_CLASS}>
        <span className="flex min-w-0 items-center gap-cell" title={note ?? undefined}>
          <span
            aria-hidden
            className={cn(
              "size-2.5 shrink-0 rounded-sm",
              datasource.color === null ? "border border-ink-muted" : TINT_SWATCH[datasource.color],
            )}
          />
          <span className="min-w-0 truncate">
            {datasource.name}
            <span className="text-ink-muted"> · {pluginName}</span>
          </span>
        </span>
      </td>
      <td className={CELL_CLASS}>
        <select
          aria-label={`AI agent access for ${datasource.name}`}
          data-testid="mcp-access"
          className={INPUT_CLASS}
          value={access}
          onChange={(event) =>
            invoke(MCP_ACTION_IDS.setAccess, { datasourceId: datasource.id, access: event.target.value as AgentAccess })
          }
        >
          {AGENT_ACCESS_LEVELS.map((level) => (
            <option key={level} value={level} disabled={lockedReason(datasource, level) !== null}>
              {AGENT_ACCESS_LABELS[level]}
            </option>
          ))}
        </select>
      </td>
      <td className={CELL_CLASS}>
        <CommitField
          label={`Schemas agents see in ${datasource.name}`}
          testId="mcp-access-schemas"
          value={(datasource.agentSchemas ?? []).join(`${SCHEMA_SEPARATOR} `)}
          placeholder={shown.length === 0 ? "All schemas" : `${SHOWN_SCHEMAS}: ${shown.join(`${SCHEMA_SEPARATOR} `)}`}
          onCommit={(text) => setPolicy(datasource, { schemas: schemaList(text) })}
        />
      </td>
      <td className={cn(CELL_CLASS, "w-24 pr-0")}>
        <CommitField
          label={`Row limit for ${datasource.name}`}
          testId="mcp-access-row-cap"
          value={
            datasource.agentRowCap === undefined || datasource.agentRowCap === null
              ? ""
              : String(datasource.agentRowCap)
          }
          placeholder={String(rowCap)}
          check={rowCapCheck}
          onCommit={(text) => setPolicy(datasource, { rowCap: text.trim() === "" ? null : Number(text) })}
        />
      </td>
    </tr>
  );
}

function AccessTable({ rowCap }: { readonly rowCap: number }) {
  const all = useDatasources((state) => state.datasources);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const datasources = all.filter(
    (datasource) => !datasource.ephemeral && (needle === "" || datasource.name.toLowerCase().includes(needle)),
  );
  if (all.every((datasource) => datasource.ephemeral))
    return <p className="col-span-2 text-ink-muted">No saved data sources yet.</p>;
  return (
    <div className="col-span-2 flex flex-col gap-cell">
      <TextInput
        aria-label="Filter data sources"
        data-testid="mcp-access-filter"
        placeholder="Filter data sources"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <table className="w-full table-fixed" aria-label="Data source access">
        <thead>
          <tr>
            <th scope="col" className={HEADER_CLASS}>
              Data source
            </th>
            <th scope="col" className={cn(HEADER_CLASS, "w-36")}>
              Access
            </th>
            <th scope="col" className={HEADER_CLASS}>
              Schemas
            </th>
            <th scope="col" className={cn(HEADER_CLASS, "w-24 pr-0")}>
              Row limit
            </th>
          </tr>
        </thead>
        <tbody>
          {datasources.map((datasource) => (
            <AccessRow key={datasource.id} datasource={datasource} rowCap={rowCap} />
          ))}
        </tbody>
      </table>
      {datasources.length === 0 ? <p className="text-ink-muted">No data source matches the filter.</p> : null}
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
      <SectionTitle>Connect a client</SectionTitle>
      <ClientSnippet port={mcp.port} />
      <SectionTitle>Clients</SectionTitle>
      <KnownClients clients={mcp.clients} />
      <SectionTitle>Data source access</SectionTitle>
      <AccessTable rowCap={mcp.rowCap} />
      <p className="col-span-2 text-ink-muted">
        New data sources start Off. Ask before writes waits for you to allow each change; the status bar chip turns
        amber until you answer. Schemas narrow what agents list and read, not what a statement may name.
      </p>
    </>
  );
}
