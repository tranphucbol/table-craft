import type { SshAuthMethod } from "@table-craft/desktop/engine/protocol.js";
import {
  DEFAULT_SSH_PORT,
  SSH_SECRET_KEYS,
  SSH_SECRET_LABELS,
  type Brand,
  type ConfigValue,
  type ConnectionField,
  type DatasourceColor,
  type DatasourceView,
  type ParsedUrl,
  type PluginInfo,
  type SaveDatasourceRequest,
  type SecretChange,
  type SecretMode,
  type SshSettings,
} from "@table-craft/desktop/preload/bridge.js";
import type { AgentAccess } from "@table-craft/desktop/settings/mcp.js";
import { keepAliveSecondsError, statementTimeoutSecondsError } from "@table-craft/desktop/settings/settings.js";

/** One datasource as the Data Sources dialog edits it: every input as typed, nothing saved yet. */
export interface FormDraft {
  /** The dialog's list key: the datasource id once saved, `new-<n>` before. */
  readonly key: string;
  readonly id: string | undefined;
  readonly name: string;
  readonly pluginId: string;
  readonly folder: string;
  readonly comment: string;
  readonly color: DatasourceColor | null;
  readonly readOnly: boolean;
  /** What MCP clients may do here (decision 127); only this form lets a red datasource ask. */
  readonly agentAccess: AgentAccess;
  /** Seconds as typed; blank is the default of 30 (decision 054). */
  readonly keepAliveSeconds: string;
  /** Seconds as typed; blank follows Settings → Editor → Running. */
  readonly statementTimeoutSeconds: string;
  /** The URL row as typed or as last filled in from a pasted URL, never with its password. */
  readonly url: string;
  /** What the last pasted URL left out or set; null until one is pasted. */
  readonly urlNote: UrlNote | null;
  /** Non-secret fields: text as typed, booleans for checkboxes. */
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly secretModes: Readonly<Record<string, SecretMode>>;
  /** Blank means keep (decision 020); typed means set; Clear means clear. */
  readonly secrets: Readonly<Record<string, SecretChange>>;
  readonly storedSecrets: readonly string[];
  /** The SSH/SSL section; only a plugin whose manifest declares `network` shows it (decision 070). */
  readonly ssh: SshDraft;
  /** Manage Shown Schemas' choice (decision 117); the form does not edit it, only keeps it. */
  readonly shownNamespaces: readonly string[] | undefined;
  /** The product picked in New Data Source or last reported by the server; the form does not edit it. */
  readonly brand: string | undefined;
  readonly ephemeral: boolean;
  readonly dirty: boolean;
}

/** The SSH tunnel as typed; its password and passphrase live in `secrets` under `SSH_SECRET_KEYS`. */
export interface SshDraft {
  readonly enabled: boolean;
  readonly host: string;
  /** As typed; blank is 22. */
  readonly port: string;
  readonly user: string;
  readonly auth: SshAuthMethod;
  readonly keyPath: string;
}

const MAX_PORT = 65_535;
const SSH_KEYS: readonly string[] = Object.values(SSH_SECRET_KEYS);

const BLANK_SSH: SshDraft = { enabled: false, host: "", port: "", user: "", auth: "password", keyPath: "" };

/** Whether the plugin's sessions can run through an SSH tunnel, so the form shows the SSH/SSL section. */
export function offersSshTunnel(plugin: PluginInfo | undefined): boolean {
  return plugin?.network != null;
}

/** The SSH secret the chosen authentication types into the form, as a secret field; agent has none. */
export function sshSecretField(ssh: SshDraft): ConnectionField | null {
  const key =
    ssh.auth === "password" ? SSH_SECRET_KEYS.password : ssh.auth === "key" ? SSH_SECRET_KEYS.passphrase : null;
  if (key === null) return null;
  return { key, label: SSH_SECRET_LABELS[key] ?? key, kind: "password", secret: true };
}

function sshDraftOf(settings: SshSettings | undefined): SshDraft {
  if (settings === undefined) return BLANK_SSH;
  return { ...settings, port: settings.port === DEFAULT_SSH_PORT ? "" : String(settings.port) };
}

/** The client key passphrase's key, which is saved only beside a client key file (decision 072). */
function keyPassphraseOf(plugin: PluginInfo | undefined): string | undefined {
  return plugin?.tls?.keyFile === undefined ? undefined : plugin.tls.keyPassphrase;
}

/** Whether the draft names a client key file, the only thing the client key passphrase unlocks. */
function namesClientKey(draft: FormDraft, plugin: PluginInfo | undefined): boolean {
  const keyFile = plugin?.tls?.keyFile;
  const value = keyFile === undefined ? undefined : draft.values[keyFile];
  return typeof value === "string" && value.trim() !== "";
}

export const CA_FILE_UNUSED_NOTE = "Use Verify CA or Verify full to check this CA file.";

/** Why a CA file the draft names would not be checked: the SSL mode does not verify; null when it would. */
export function caFileNote(draft: FormDraft, plugin: PluginInfo | undefined): string | null {
  const tls = plugin?.tls;
  if (tls?.caFile === undefined) return null;
  const caFile = draft.values[tls.caFile];
  if (typeof caFile !== "string" || caFile.trim() === "") return null;
  const mode = draft.values[tls.mode];
  return typeof mode === "string" && tls.verifyModes.includes(mode) ? null : CA_FILE_UNUSED_NOTE;
}

/** The plugin's certificate fields in the order the SSL part of the form draws them: mode, CA, certificate, key, passphrase. */
export function tlsFieldsOf(plugin: PluginInfo | undefined): readonly ConnectionField[] {
  const tls = plugin?.tls;
  if (tls === undefined || tls === null) return [];
  const keys = [tls.mode, tls.caFile, tls.certFile, tls.keyFile, tls.keyPassphrase];
  return keys.flatMap((key) => plugin?.fields.find((field) => field.key === key) ?? []);
}

/** Every secret key the form keeps a mode and a change for: the plugin's, then the tunnel's. */
function secretKeysOf(plugin: PluginInfo | undefined): readonly string[] {
  const own = secretFieldsOf(plugin).map((field) => field.key);
  return offersSshTunnel(plugin) ? [...own, ...SSH_KEYS] : own;
}

/** Whether the user touched the SSH section; an untouched one is not saved, so the record has no `ssh`. */
function sshTouched(ssh: SshDraft): boolean {
  return ssh.enabled || ssh.host.trim() !== "" || ssh.user.trim() !== "" || ssh.keyPath.trim() !== "";
}

/** The outcome of pasting a URL, for the line under the URL row. */
export type UrlNote =
  | {
      readonly kind: "applied";
      /** Secret fields the URL filled, by label. */
      readonly secrets: readonly string[];
      readonly ignored: readonly string[];
    }
  | { readonly kind: "failed"; readonly message: string; readonly hint: string };

const KEEP: SecretChange = { action: "keep" };

export function secretFieldsOf(plugin: PluginInfo | undefined): readonly ConnectionField[] {
  return (plugin?.fields ?? []).filter((field) => field.secret === true);
}

function plainFieldsOf(plugin: PluginInfo | undefined): readonly ConnectionField[] {
  return (plugin?.fields ?? []).filter((field) => field.secret !== true);
}

function secondsInput(seconds: number | undefined): string {
  return seconds === undefined ? "" : String(seconds);
}

function inputOf(field: ConnectionField, value: ConfigValue | undefined): string | boolean {
  if (field.kind === "checkbox") return value === true;
  return value === undefined ? "" : String(value);
}

/** `base`, else `base (2)`, `base (3)`… whichever no datasource has yet. */
export function uniqueName(base: string, taken: readonly string[]): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base} (${String(index)})`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * A record saved before its tunnel or client key was set up has no modes for their secrets; they
 * start as the database password's, the choice the user already made for this datasource.
 */
function withLaterModes(
  modes: Readonly<Record<string, SecretMode>>,
  plugin: PluginInfo | undefined,
): Readonly<Record<string, SecretMode>> {
  const first = secretFieldsOf(plugin)[0];
  const fallback = (first === undefined ? undefined : modes[first.key]) ?? "never";
  const filled = { ...modes };
  if (offersSshTunnel(plugin)) for (const key of SSH_KEYS) filled[key] ??= fallback;
  const passphrase = keyPassphraseOf(plugin);
  if (passphrase !== undefined) filled[passphrase] ??= fallback;
  return filled;
}

export function draftFromView(view: DatasourceView, plugin: PluginInfo | undefined): FormDraft {
  const values: Record<string, string | boolean> = {};
  for (const field of plainFieldsOf(plugin)) values[field.key] = inputOf(field, view.config[field.key]);
  const secrets: Record<string, SecretChange> = {};
  for (const key of secretKeysOf(plugin)) secrets[key] = KEEP;
  return {
    key: view.id,
    id: view.id,
    name: view.name,
    pluginId: view.pluginId,
    folder: view.folder ?? "",
    comment: view.comment,
    color: view.color,
    readOnly: view.readOnly,
    agentAccess: view.agentAccess ?? "off",
    keepAliveSeconds: secondsInput(view.keepAliveSeconds),
    statementTimeoutSeconds: secondsInput(view.statementTimeoutSeconds),
    url: "",
    urlNote: null,
    values,
    secretModes: withLaterModes(view.secretModes, plugin),
    secrets,
    storedSecrets: view.storedSecrets,
    ssh: sshDraftOf(view.ssh),
    shownNamespaces: view.shownNamespaces,
    brand: view.brand,
    ephemeral: view.ephemeral,
    dirty: false,
  };
}

export function newDraft(
  key: string,
  plugin: PluginInfo,
  taken: readonly string[],
  defaultMode: SecretMode,
  folder = "",
  brand: Brand | null = null,
): FormDraft {
  const values: Record<string, string | boolean> = {};
  for (const field of plainFieldsOf(plugin)) values[field.key] = inputOf(field, field.default);
  const secretModes: Record<string, SecretMode> = {};
  const secrets: Record<string, SecretChange> = {};
  for (const key of secretKeysOf(plugin)) {
    secretModes[key] = defaultMode;
    secrets[key] = KEEP;
  }
  return {
    key,
    id: undefined,
    name: uniqueName(brand?.name ?? plugin.name, taken),
    pluginId: plugin.id,
    folder,
    comment: "",
    color: null,
    readOnly: false,
    agentAccess: "off",
    keepAliveSeconds: "",
    statementTimeoutSeconds: "",
    url: "",
    urlNote: null,
    values,
    secretModes,
    secrets,
    storedSecrets: [],
    ssh: BLANK_SSH,
    shownNamespaces: undefined,
    brand: brand?.id,
    ephemeral: false,
    dirty: true,
  };
}

/** A copy that saves as a new datasource; secrets are not copied, so the user types them again. */
export function duplicateDraft(
  key: string,
  view: DatasourceView,
  plugin: PluginInfo | undefined,
  taken: readonly string[],
  defaultMode: SecretMode,
): FormDraft {
  const source = draftFromView(view, plugin);
  const secretModes: Record<string, SecretMode> = {};
  for (const key of secretKeysOf(plugin)) {
    const mode = source.secretModes[key] ?? defaultMode;
    secretModes[key] = view.ephemeral ? defaultMode : mode;
  }
  return {
    ...source,
    key,
    id: undefined,
    name: uniqueName(`${view.name} copy`, taken),
    secretModes,
    storedSecrets: [],
    ephemeral: false,
    dirty: true,
  };
}

/**
 * Whether the form draws `field`: always, unless its `visibleWhen` names a select or checkbox that
 * holds another value (plan 058 decision 3). A hidden field is neither checked nor saved.
 */
export function fieldVisible(field: ConnectionField, draft: Pick<FormDraft, "values">): boolean {
  const rule = field.visibleWhen;
  if (rule === undefined) return true;
  return draft.values[rule.key] === rule.equals;
}

/** What stops the draft from saving, as sentences; empty when it can. */
export function draftProblems(draft: FormDraft, plugin: PluginInfo | undefined): readonly string[] {
  const problems: string[] = [];
  if (draft.name.trim() === "") problems.push("Name is required.");
  for (const field of plainFieldsOf(plugin)) {
    if (!fieldVisible(field, draft)) continue;
    const value = draft.values[field.key];
    if (typeof value !== "string") continue;
    if (field.required === true && value.trim() === "") problems.push(`${field.label} is required.`);
    if (field.kind === "number" && value.trim() !== "" && !Number.isFinite(Number(value))) {
      problems.push(`${field.label} must be a number.`);
    }
  }
  const keepAlive = secondsOf(draft.keepAliveSeconds);
  if (Number.isNaN(keepAlive)) problems.push("The keepalive interval must be a whole number of seconds.");
  else if (keepAlive !== undefined) pushError(problems, keepAliveSecondsError(keepAlive));
  const timeout = secondsOf(draft.statementTimeoutSeconds);
  if (Number.isNaN(timeout)) problems.push("The statement timeout must be a whole number of seconds.");
  else if (timeout !== undefined) pushError(problems, statementTimeoutSecondsError(timeout));
  if (offersSshTunnel(plugin) && draft.ssh.enabled) problems.push(...sshProblems(draft.ssh));
  return problems;
}

function sshProblems(ssh: SshDraft): string[] {
  const problems: string[] = [];
  if (ssh.host.trim() === "") problems.push("SSH host is required.");
  if (Number.isNaN(sshPortOf(ssh.port)))
    problems.push(`The SSH port must be a whole number from 1 to ${String(MAX_PORT)}.`);
  if (ssh.user.trim() === "") problems.push("SSH user is required.");
  if (ssh.auth === "key" && ssh.keyPath.trim() === "") problems.push("The private key file is required.");
  return problems;
}

/** 22 when blank, NaN when not a port. */
function sshPortOf(text: string): number {
  const port = secondsOf(text) ?? DEFAULT_SSH_PORT;
  return port >= 1 && port <= MAX_PORT ? port : Number.NaN;
}

function sshSettingsOf(ssh: SshDraft): SshSettings {
  const port = sshPortOf(ssh.port);
  return {
    enabled: ssh.enabled,
    host: ssh.host.trim(),
    port: Number.isNaN(port) ? DEFAULT_SSH_PORT : port,
    user: ssh.user.trim(),
    auth: ssh.auth,
    keyPath: ssh.keyPath.trim(),
  };
}

function pushError(problems: string[], error: string | null): void {
  if (error !== null) problems.push(error);
}

/** Undefined when blank, NaN when not a whole number. */
function secondsOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function configValue(field: ConnectionField, value: string | boolean | undefined): ConfigValue | undefined {
  if (field.kind === "checkbox") return value === true;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return field.kind === "number" ? Number(value) : value;
}

function secondsField(key: string, text: string): Record<string, number> {
  const seconds = secondsOf(text);
  return seconds === undefined || Number.isNaN(seconds) ? {} : { [key]: seconds };
}

export function toSaveRequest(draft: FormDraft, plugin: PluginInfo | undefined): SaveDatasourceRequest {
  const config: Record<string, ConfigValue> = {};
  for (const field of plainFieldsOf(plugin)) {
    if (!fieldVisible(field, draft)) continue;
    const value = configValue(field, draft.values[field.key]);
    if (value !== undefined) config[field.key] = value;
  }
  const folder = draft.folder.trim();
  const tunnel = offersSshTunnel(plugin) && sshTouched(draft.ssh);
  const clientKey = namesClientKey(draft, plugin);
  const kept = (key: string): boolean =>
    (tunnel || !SSH_KEYS.includes(key)) && (clientKey || key !== keyPassphraseOf(plugin));
  return {
    datasource: {
      id: draft.id,
      name: draft.name.trim(),
      pluginId: draft.pluginId,
      folder: folder === "" ? null : folder,
      color: draft.color,
      readOnly: draft.readOnly,
      ...(draft.agentAccess === "off" ? {} : { agentAccess: draft.agentAccess }),
      ...secondsField("keepAliveSeconds", draft.keepAliveSeconds),
      ...secondsField("statementTimeoutSeconds", draft.statementTimeoutSeconds),
      comment: draft.comment,
      config,
      secretModes: Object.fromEntries(Object.entries(draft.secretModes).filter(([key]) => kept(key))),
      ...(tunnel ? { ssh: sshSettingsOf(draft.ssh) } : {}),
      ...(draft.shownNamespaces === undefined ? {} : { shownNamespaces: draft.shownNamespaces }),
      ...(draft.brand === undefined ? {} : { brand: draft.brand }),
    },
    secrets: Object.fromEntries(Object.entries(draft.secrets).filter(([key]) => kept(key))),
  };
}

/** The placeholder a secret input shows: whether a value is stored, and what blank means. */
export function secretPlaceholder(draft: FormDraft, key: string): string {
  const change = draft.secrets[key] ?? KEEP;
  if (change.action === "clear") return "Cleared on save";
  if (draft.storedSecrets.includes(key)) return "Saved; leave blank to keep";
  if (draft.secretModes[key] === "never") return "Asked for on every connect";
  return "";
}

/**
 * The draft with a pasted URL's fields filled in. Fields the URL does not name keep what they
 * held; a password becomes the secret field's typed value, saved by its mode (decision 020), and
 * the URL row shows the URL without it.
 */
export function applyParsedUrl(
  draft: FormDraft,
  plugin: PluginInfo | undefined,
  parsed: ParsedUrl,
  url: string,
): FormDraft {
  const values = { ...draft.values };
  for (const field of plainFieldsOf(plugin)) {
    const value = parsed.values[field.key];
    if (value !== undefined) values[field.key] = inputOf(field, value);
  }
  const secrets = { ...draft.secrets };
  const filled: string[] = [];
  for (const field of secretFieldsOf(plugin)) {
    const value = parsed.secrets[field.key];
    if (value === undefined) continue;
    secrets[field.key] = { action: "set", value };
    filled.push(field.label);
  }
  return {
    ...draft,
    values,
    secrets,
    url: filled.length === 0 ? url.trim() : withoutPassword(url.trim()),
    urlNote: { kind: "applied", secrets: filled, ignored: parsed.ignored },
    dirty: true,
  };
}

const USERINFO_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^:@/?#]*):[^@/?#]*@/i;
const PASSWORD_PARAM = /([?&])password=[^&#]*&?/i;
const TRAILING_SEPARATOR = /[?&](?=#|$)/;

/** The URL without the password of its userinfo or a `password=` parameter; it stays in the secret field only. */
export function withoutPassword(url: string): string {
  return url.replace(USERINFO_PASSWORD, "$1@").replace(PASSWORD_PARAM, "$1").replace(TRAILING_SEPARATOR, "");
}
