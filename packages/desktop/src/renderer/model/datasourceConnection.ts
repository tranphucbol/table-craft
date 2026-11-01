import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { FormDraft } from "@table-craft/desktop/renderer/model/datasourceForm.js";

const ENDPOINT_SEPARATOR = /[,\n]/;
const ENDPOINT_ADDRESS = /^(?:\[([^\]]+)\]|([^:\s/@?#]+)):(\d+)$/;
const MAX_PORT = 65_535;
export const MAX_CONNECTION_ENDPOINTS = 100;

/** The scalar endpoint/auth feature contract, independent of plugin identity. */
export function offersEndpointConnection(plugin: PluginInfo | undefined): boolean {
  return (
    plugin?.network != null &&
    plugin.tls != null &&
    plugin.fields.some((field) => field.key === "endpoints" && field.kind === "text") &&
    plugin.fields.some(
      (field) => field.key === "authMode" && field.options?.some((option) => option.value === "clientCN"),
    )
  );
}

/** Configured rows, or the legacy primary address until the list is first edited. */
export function endpointRows(draft: FormDraft, plugin: PluginInfo): readonly string[] {
  const endpoints = draft.values.endpoints;
  if (typeof endpoints === "string" && endpoints !== "")
    return endpoints.split(ENDPOINT_SEPARATOR).map((row) => row.trim());
  const network = plugin.network;
  if (network == null) return [""];
  const host = String(draft.values[network.host] ?? "");
  const port = String(draft.values[network.port] ?? "");
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return [host === "" ? "" : `${bracketed}:${port}`];
}

/** The same host-side test path, with one configured target at a time and no transport bypass. */
export function endpointTestDrafts(
  draft: FormDraft,
  plugin: PluginInfo,
): readonly { readonly id: string; readonly draft: FormDraft }[] {
  return endpointRows(draft, plugin).map((row, index) => ({
    id: `endpoint-${String(index + 1)}`,
    draft: { ...draft, values: { ...draft.values, endpoints: row } },
  }));
}

/** Full HTTP(S) endpoint pastes set the shared TLS mode; credentials and URL suffixes are never accepted. */
export function endpointRowsChange(draft: FormDraft, plugin: PluginInfo, rows: readonly string[]): Partial<FormDraft> {
  const values = { ...draft.values };
  const schemes = new Set(rows.flatMap((row) => /^(https?):\/\//i.exec(row.trim())?.[1]?.toLowerCase() ?? []));
  if (schemes.size > 1) return { values: { ...values, endpoints: rows.join("\n") } };
  const normalized = rows.map((row) => {
    const match = /^(https?):\/\/([^/?#@]+)\/?$/i.exec(row.trim());
    if (match === null || !ENDPOINT_ADDRESS.test(match[2] ?? "")) return row;
    const mode = plugin.tls?.mode;
    if (mode !== undefined) {
      if (match[1]?.toLowerCase() === "https") {
        const current = values[mode];
        if (typeof current !== "string" || current === "disable" || current === "") values[mode] = "verify-full";
      } else {
        values[mode] = "disable";
      }
    }
    return match[2] ?? row;
  });
  values.endpoints = normalized.join("\n");
  if (normalized.length === 1 && normalized[0]?.trim() === "" && plugin.network != null) {
    values[plugin.network.host] = "";
    values[plugin.network.port] = "";
  }
  return { values };
}

/** Endpoint validation mirrors the scalar transport format without accepting URLs into saved config. */
export function endpointProblems(draft: FormDraft, plugin: PluginInfo): readonly string[] {
  const value = draft.values.endpoints;
  const rows =
    typeof value !== "string" || value === "" ? endpointRows(draft, plugin) : value.split(ENDPOINT_SEPARATOR);
  if (rows.length > MAX_CONNECTION_ENDPOINTS) return [`Use at most ${MAX_CONNECTION_ENDPOINTS} endpoints.`];
  const seen = new Set<string>();
  for (const row of rows) {
    const match = ENDPOINT_ADDRESS.exec(row.trim());
    const port = Number(match?.[3]);
    if (match === null || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
      return ["Each endpoint must be host:port (bracket IPv6), with no empty rows, credentials or URL suffixes."];
    }
    const target = `${(match[1] ?? match[2])?.toLowerCase()}:${String(port)}`;
    if (seen.has(target)) return ["Endpoints must not contain duplicate targets."];
    seen.add(target);
  }
  return [];
}

export function connectionProblems(draft: FormDraft, plugin: PluginInfo): readonly string[] {
  const problems = [...endpointProblems(draft, plugin)];
  if (draft.values.authMode === "password" && String(draft.values.user ?? "").trim() === "")
    problems.push("User is required for password authentication.");
  if (draft.values.authMode === "clientCN") {
    const tls = plugin.tls;
    const mode = tls == null ? "disable" : draft.values[tls.mode];
    if (mode === "disable" || mode === "" || mode === undefined)
      problems.push("Client-certificate authentication requires TLS.");
    if (tls?.certFile === undefined || String(draft.values[tls.certFile] ?? "").trim() === "")
      problems.push("Choose a client certificate for client-certificate authentication.");
    if (tls?.keyFile === undefined || String(draft.values[tls.keyFile] ?? "").trim() === "")
      problems.push("Choose a client key for client-certificate authentication.");
  }
  if (draft.values.namespaceEncoding === "base64") {
    const namespace = String(draft.values.namespace ?? "");
    try {
      if (btoa(atob(namespace)) !== namespace) problems.push("Key prefix must be canonical Base64.");
    } catch {
      problems.push("Key prefix must be canonical Base64.");
    }
  }
  return problems;
}

/** Help describes the implemented configured-target policy, not automatic member discovery. */
export function connectionFieldHelp(key: string): string | null {
  switch (key) {
    case "namespace":
      return "Every key is read and written under this prefix, and the tree shows keys without it. It does not limit access: cluster, lease and user operations still apply to the whole cluster.";
    case "serverName":
      return "The host name every endpoint's certificate is checked against, also through SSH. Leave blank to check each endpoint's own host name.";
    case "autoSyncInterval":
      return "How often to recheck that the endpoints above still belong to the same cluster. 0, the default, turns it off. Members the cluster advertises are never added.";
    case "lockPrefix":
    case "electionPrefix":
      return "A prefix, under the namespace, to list for viewing. TableCraft only reads it: it never takes a lock or runs an election. Leave blank to skip.";
    case "namespaceEncoding":
      return "How the namespace is written: UTF-8 text, or Base64 for an exact byte prefix.";
    case "readMode":
      return "Linearizable reads always see the latest data. Serializable reads can be faster but may be slightly out of date.";
    case "maxRequestBytes":
      return "The largest request TableCraft sends, in bytes. The server may accept less.";
    case "maxMessageMb":
      return "The largest response TableCraft accepts, in MiB. It also caps the size of what it sends.";
    default:
      return null;
  }
}
