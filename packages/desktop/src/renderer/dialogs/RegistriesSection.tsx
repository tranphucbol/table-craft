import { useId, useState, type KeyboardEvent } from "react";
import type { PluginInfo, PluginRegistryState, RegistryCheck } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import {
  PLUGIN_ACTION_IDS,
  type RegistryArgs,
  type RegistrySaveArgs,
  type RegistryTestArgs,
  type RegistryTokenArgs,
} from "@table-craft/desktop/renderer/actions/pluginActions.js";
import { Button, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  LooseNote,
  LooseRow,
  LooseTitle,
  RegistryCard,
  ScopeChip,
} from "@table-craft/desktop/renderer/dialogs/pluginsParts.js";
import { update, useDraft } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { registryCheckText, registryHost } from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { REGISTRY_FORM_KEY, useRegistryTests } from "@table-craft/desktop/renderer/state/registryTests.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";
import {
  newRegistryId,
  OFFICIAL_PLUGIN_SCOPE,
  registryEntryError,
  registryScopeError,
  registryUrlError,
  type PluginRegistry,
} from "@table-craft/desktop/settings/settings.js";

const CHECK_TICK_MS = 30_000;
/** `editing` while the Add form is open; a saved registry's id never is empty. */
const NEW_REGISTRY = "";
const STATUS_DOT = "●";

function latestCheck(...checks: readonly (RegistryCheck | null | undefined)[]): RegistryCheck | null {
  return checks.reduce<RegistryCheck | null>(
    (latest, check) => (check == null || (latest !== null && latest.at >= check.at) ? latest : check),
    null,
  );
}

function CheckStatus({ check, now }: { readonly check: RegistryCheck | null; readonly now: number }) {
  if (check === null) return null;
  const tone = check.status === "reached" ? "text-success" : "text-danger";
  return (
    <span
      role={check.status === "reached" ? "status" : "alert"}
      title={check.status === "failed" ? check.message : undefined}
      className={cn("truncate", tone)}
    >
      {STATUS_DOT} {registryCheckText(check, now)}
    </span>
  );
}

function NpmCard() {
  const registryUrl = useSettings((state) => state.settings.plugins.registryUrl);
  const id = useId();
  const errorId = useId();
  const { text, edit } = useDraft(registryUrl, (value) => value);
  const error = registryUrlError(text);
  return (
    <RegistryCard
      label="npm"
      title={
        <>
          <span className="flex-1 font-semibold">npm</span>
          <span className="rounded border border-line px-cell text-ink-muted">default</span>
        </>
      }
    >
      <LooseRow
        label="URL"
        htmlFor={id}
        error={error}
        errorId={errorId}
        hint="The public npm registry, or a mirror of it your company runs."
      >
        <TextInput
          id={id}
          className="flex-1"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          value={text}
          onChange={(event) => {
            const next = event.target.value.trim();
            const valid = registryUrlError(next) === null;
            edit(event.target.value, valid ? next : registryUrl);
            if (valid) update((current) => ({ ...current, plugins: { ...current.plugins, registryUrl: next } }));
          }}
        />
      </LooseRow>
      <LooseRow label="Serves">
        <span>Every scope not listed below, and always {OFFICIAL_PLUGIN_SCOPE}.</span>
      </LooseRow>
    </RegistryCard>
  );
}

function TokenField({
  registryId,
  placeholder,
  onReplaced,
}: {
  readonly registryId: string;
  readonly placeholder: string;
  readonly onReplaced: () => void;
}) {
  const [token, setToken] = useState("");
  const args: RegistryTokenArgs = { registryId, token: token.trim() };
  return (
    <>
      <TextInput
        type="password"
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        className="flex-1"
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <Button
        disabled={args.token === ""}
        onClick={() => {
          invoke(PLUGIN_ACTION_IDS.setRegistryToken, args);
          setToken("");
          onReplaced();
        }}
      >
        Replace
      </Button>
    </>
  );
}

function PrivateCard({
  registry,
  plugins,
  onEdit,
}: {
  readonly registry: PluginRegistryState;
  readonly plugins: readonly PluginInfo[];
  readonly onEdit: () => void;
}) {
  const now = useClock(CHECK_TICK_MS);
  const running = useRegistryTests((state) => state.running.has(registry.id));
  const tested = useRegistryTests((state) => state.results[registry.id]);
  const [replacing, setReplacing] = useState(false);
  const check = latestCheck(registry.check, tested);
  const refused = check?.status === "refused";
  const removeArgs: RegistryArgs = { registryId: registry.id };
  const testArgs: RegistryTestArgs = {
    key: registry.id,
    request: { registryId: registry.id, url: registry.url, scopes: registry.scopes, token: null },
  };
  const names = registry.plugins.map((id) => plugins.find((plugin) => plugin.id === id)?.name ?? id);
  return (
    <RegistryCard
      label={registry.name}
      danger={refused}
      title={
        <>
          <span className="font-semibold">{registry.name}</span>
          <span className="min-w-0 flex-1">
            <CheckStatus check={check} now={now} />
          </span>
          <Button disabled={running} onClick={() => invoke(PLUGIN_ACTION_IDS.testRegistry, testArgs)}>
            {running ? "Testing…" : "Test"}
          </Button>
          <Button onClick={onEdit}>Edit</Button>
          <Button onClick={() => invoke(PLUGIN_ACTION_IDS.removeRegistry, removeArgs)}>Remove</Button>
        </>
      }
    >
      <LooseRow label="URL">
        <span className="truncate">{registry.url}</span>
      </LooseRow>
      <LooseRow label="Scopes">
        {registry.scopes.map((scope) => (
          <ScopeChip key={scope} scope={scope} />
        ))}
      </LooseRow>
      <LooseRow label="Token" hint={`Sent only to ${registryHost(registry.url)}.`}>
        {refused || replacing || !registry.tokenStored ? (
          <TokenField
            registryId={registry.id}
            placeholder={registry.tokenStored ? "Paste a new token" : "Token"}
            onReplaced={() => setReplacing(false)}
          />
        ) : (
          <>
            <span>Stored, encrypted</span>
            <Button onClick={() => setReplacing(true)}>Replace</Button>
            <Button onClick={() => invoke(PLUGIN_ACTION_IDS.clearRegistryToken, removeArgs)}>Forget</Button>
          </>
        )}
      </LooseRow>
      <LooseRow
        label="Plugins"
        {...(registry.integrity === "sha1"
          ? { hint: "Downloads are checked with SHA-1, the only checksum this registry gives." }
          : {})}
      >
        <span className={cn(names.length === 0 && "text-ink-muted")}>
          {names.length === 0 ? "None installed yet" : names.join(", ")}
        </span>
      </LooseRow>
    </RegistryCard>
  );
}

interface Draft {
  readonly name: string;
  readonly url: string;
  readonly scopes: readonly string[];
  readonly scopeText: string;
  readonly token: string;
}

function draftOf(registry: PluginRegistry | undefined): Draft {
  return {
    name: registry?.name ?? "",
    url: registry?.url ?? "",
    scopes: registry?.scopes ?? [],
    scopeText: "",
    token: "",
  };
}

function RegistryForm({
  saved,
  editing,
  onClose,
}: {
  readonly saved: readonly PluginRegistry[];
  readonly editing: PluginRegistry | undefined;
  readonly onClose: () => void;
}) {
  const [draft, setDraftState] = useState(() => draftOf(editing));
  /** A test result stands only for the address, scopes and token it was taken with. */
  const setDraft = (next: Draft) => {
    const basis = (value: Draft) => [value.url, value.token, value.scopes.join(" "), value.scopeText].join("\n");
    if (basis(next) !== basis(draft)) {
      useRegistryTests.getState().forget(REGISTRY_FORM_KEY);
    }
    setDraftState(next);
  };
  const running = useRegistryTests((state) => state.running.has(REGISTRY_FORM_KEY));
  const tested = useRegistryTests((state) => state.results[REGISTRY_FORM_KEY]);
  const now = useClock(CHECK_TICK_MS);
  const ids = { name: useId(), url: useId(), scopes: useId(), token: useId(), error: useId() };
  const others = saved.filter((other) => other.id !== editing?.id);
  const pendingScope = draft.scopeText.trim().toLowerCase();
  const scopeError = pendingScope === "" ? null : registryScopeError(pendingScope, others);
  const scopes =
    scopeError === null && pendingScope !== "" ? [...new Set([...draft.scopes, pendingScope])] : draft.scopes;
  const entry: PluginRegistry = {
    id: editing?.id ?? newRegistryId(draft.name, others),
    name: draft.name.trim(),
    url: draft.url.trim(),
    scopes,
    packages: editing?.packages ?? [],
  };
  const urlError = draft.url.trim() === "" ? null : registryUrlError(entry.url);
  const entryError = registryEntryError(entry, others);
  const token = draft.token.trim();
  const close = () => {
    useRegistryTests.getState().forget(REGISTRY_FORM_KEY);
    onClose();
  };
  const addScope = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || pendingScope === "" || scopeError !== null) return;
    event.preventDefault();
    setDraft({ ...draft, scopes, scopeText: "" });
  };
  const testArgs: RegistryTestArgs = {
    key: REGISTRY_FORM_KEY,
    request: { registryId: editing?.id ?? null, url: entry.url, scopes, token: token === "" ? null : token },
  };
  const saveArgs: RegistrySaveArgs = { registry: entry, token: token === "" ? null : token };
  const title = editing === undefined ? "New registry" : `Edit ${editing.name}`;
  return (
    <RegistryCard label={title} title={<span className="font-semibold">{title}</span>}>
      <LooseRow label="Name" htmlFor={ids.name}>
        <TextInput
          id={ids.name}
          className="flex-1"
          placeholder="Company registry"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </LooseRow>
      <LooseRow
        label="URL"
        htmlFor={ids.url}
        error={urlError}
        hint="https only: the npm endpoint of GitLab, Nexus, Artifactory or Verdaccio."
      >
        <TextInput
          id={ids.url}
          className="flex-1"
          placeholder="https://gitlab.example.com/api/v4/packages/npm"
          aria-invalid={urlError !== null}
          value={draft.url}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        />
      </LooseRow>
      <LooseRow
        label="Scopes"
        htmlFor={ids.scopes}
        error={scopeError}
        hint={`Enter adds a scope. ${OFFICIAL_PLUGIN_SCOPE} always comes from npm.`}
      >
        {draft.scopes.map((scope) => (
          <ScopeChip
            key={scope}
            scope={scope}
            onRemove={() => setDraft({ ...draft, scopes: draft.scopes.filter((other) => other !== scope) })}
          />
        ))}
        <TextInput
          id={ids.scopes}
          className="min-w-0 flex-1"
          placeholder="@acme"
          aria-invalid={scopeError !== null}
          value={draft.scopeText}
          onKeyDown={addScope}
          onChange={(event) => setDraft({ ...draft, scopeText: event.target.value })}
        />
      </LooseRow>
      <LooseRow
        label="Token"
        htmlFor={ids.token}
        hint="For GitLab, a token with read_api. Kept encrypted, sent only to this host, never shown again."
      >
        <TextInput
          id={ids.token}
          type="password"
          autoComplete="off"
          className="flex-1"
          placeholder={editing === undefined ? "" : "Leave empty to keep the stored token"}
          value={draft.token}
          onChange={(event) => setDraft({ ...draft, token: event.target.value })}
        />
      </LooseRow>
      <LooseRow label="" error={draft.name.trim() === "" ? null : entryError} errorId={ids.error}>
        <Button
          disabled={running || urlError !== null || entry.url === "" || scopes.length === 0}
          onClick={() => invoke(PLUGIN_ACTION_IDS.testRegistry, testArgs)}
        >
          {running ? "Testing…" : "Test connection"}
        </Button>
        <span className="min-w-0 flex-1">
          <CheckStatus check={tested ?? null} now={now} />
        </span>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          disabled={entryError !== null}
          onClick={() => {
            if (tested !== undefined) useRegistryTests.getState().finish(entry.id, tested);
            invoke(PLUGIN_ACTION_IDS.saveRegistry, saveArgs);
            close();
          }}
        >
          Save
        </Button>
      </LooseRow>
    </RegistryCard>
  );
}

/** Settings → Plugins' Registries: npm first, then each private registry as a card (plan 154). */
export function RegistriesSection() {
  const registries = useDatasources((state) => state.registries);
  const plugins = useDatasources((state) => state.plugins);
  const saved = useSettings((state) => state.settings.plugins.registries);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      <LooseTitle
        action={
          <Button disabled={editing === NEW_REGISTRY} onClick={() => setEditing(NEW_REGISTRY)}>
            + Add registry
          </Button>
        }
      >
        Registries
      </LooseTitle>
      <NpmCard />
      {registries.map((registry) =>
        editing === registry.id ? (
          <RegistryForm
            key={registry.id}
            saved={saved}
            editing={saved.find((entry) => entry.id === registry.id)}
            onClose={() => setEditing(null)}
          />
        ) : (
          <PrivateCard key={registry.id} registry={registry} plugins={plugins} onEdit={() => setEditing(registry.id)} />
        ),
      )}
      {editing === NEW_REGISTRY ? (
        <RegistryForm saved={saved} editing={undefined} onClose={() => setEditing(null)} />
      ) : null}
      {registries.length === 0 && editing !== NEW_REGISTRY ? (
        <LooseNote>
          Add a registry to install your company’s plugins: a GitLab, Nexus, Artifactory or Verdaccio npm endpoint that
          serves a scope such as @acme.
        </LooseNote>
      ) : null}
    </>
  );
}
