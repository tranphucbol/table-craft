import { useId } from "react";
import type { CatalogPlugin, PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { PLUGIN_ACTION_IDS, type PluginArgs } from "@table-craft/desktop/renderer/actions/pluginActions.js";
import { Button, FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { FieldError, SectionTitle, update, useDraft } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { downloadLabel, installText, SOURCE_LABELS } from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { DatasourceGlyph } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { registryUrlError } from "@table-craft/desktop/settings/settings.js";

function Progress({ entry }: { readonly entry: CatalogPlugin | undefined }) {
  const text = entry === undefined ? null : installText(entry);
  if (entry === undefined || text === null) return null;
  const failed = entry.install.status === "failed";
  return (
    <span
      role={failed ? "alert" : "status"}
      title={entry.install.status === "failed" ? entry.install.hint : undefined}
      className={cn("truncate", failed ? "text-danger" : "text-ink-muted")}
    >
      {text}
    </span>
  );
}

function InstalledRow({ plugin, entry }: { readonly plugin: PluginInfo; readonly entry: CatalogPlugin | undefined }) {
  const args: PluginArgs = { pluginId: plugin.id };
  const busy = entry?.install.status === "installing";
  return (
    <FieldRow label={plugin.name}>
      <span data-plugin-row={plugin.id} className="flex min-w-0 items-center gap-cell">
        <DatasourceGlyph brand={plugin.brands[0] ?? null} className="size-icon shrink-0" />
        <span className="shrink-0">{plugin.version ?? ""}</span>
        <span className="shrink-0 text-ink-muted">{SOURCE_LABELS[plugin.source]}</span>
        {plugin.unavailableReason === null ? null : (
          <span className="truncate text-danger">{plugin.unavailableReason}</span>
        )}
        <Progress entry={entry} />
        {plugin.source === "managed" && entry !== undefined ? (
          <Button disabled={busy} onClick={() => invoke(PLUGIN_ACTION_IDS.install, args)}>
            Update
          </Button>
        ) : null}
        {plugin.source === "managed" ? (
          <Button disabled={busy} onClick={() => invoke(PLUGIN_ACTION_IDS.remove, args)}>
            Remove
          </Button>
        ) : null}
      </span>
    </FieldRow>
  );
}

function DownloadRow({ entry }: { readonly entry: CatalogPlugin }) {
  const args: PluginArgs = { pluginId: entry.id };
  return (
    <FieldRow label={entry.name}>
      <span data-plugin-row={entry.id} className="flex min-w-0 items-center gap-cell">
        <DatasourceGlyph brand={entry.brands[0] ?? null} tone="muted" className="size-icon shrink-0" />
        <span className="shrink-0 text-ink-muted">{entry.packageName}</span>
        <Progress entry={entry} />
        <Button
          disabled={entry.install.status === "installing"}
          onClick={() => invoke(PLUGIN_ACTION_IDS.install, args)}
        >
          {downloadLabel(entry)}
        </Button>
      </span>
    </FieldRow>
  );
}

function RegistryField() {
  const registryUrl = useSettings((state) => state.settings.plugins.registryUrl);
  const id = useId();
  const errorId = useId();
  const { text, edit } = useDraft(registryUrl, (value) => value);
  const error = registryUrlError(text);
  return (
    <>
      <FieldRow label="Registry" htmlFor={id}>
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
            if (valid) update((current) => ({ ...current, plugins: { registryUrl: next } }));
          }}
        />
      </FieldRow>
      <FieldError id={errorId} error={error} />
      <p className="col-start-2 text-ink-muted">
        Where TableCraft downloads its plugins from: the public npm registry, or a mirror of it your company runs.
      </p>
    </>
  );
}

/** Settings → Plugins: what is installed and from where, what can be downloaded, and the registry. */
export function PluginsPage() {
  const plugins = useDatasources((state) => state.plugins);
  const catalog = useDatasources((state) => state.catalog);
  const downloadable = catalog.filter((entry) => !plugins.some((plugin) => plugin.id === entry.id));
  return (
    <>
      <SectionTitle>Installed</SectionTitle>
      {plugins.map((plugin) => (
        <InstalledRow key={plugin.id} plugin={plugin} entry={catalog.find((candidate) => candidate.id === plugin.id)} />
      ))}
      <p className="col-start-2 text-ink-muted">
        Downloaded plugins update in the background while “Check for updates automatically” is on.
      </p>
      <SectionTitle>Available</SectionTitle>
      {downloadable.length === 0 ? (
        <p className="col-start-2 text-ink-muted">Every plugin TableCraft offers is installed.</p>
      ) : (
        downloadable.map((entry) => <DownloadRow key={entry.id} entry={entry} />)
      )}
      <SectionTitle>From a file</SectionTitle>
      <FieldRow label="Package">
        <ActionButton actionId={PLUGIN_ACTION_IDS.installFile} />
      </FieldRow>
      <p className="col-start-2 text-ink-muted">
        For a machine without the registry: a plugin’s .tgz from the release page. A plugin runs with TableCraft’s
        access to your files and network, so install only ones you trust.
      </p>
      <SectionTitle>Registry</SectionTitle>
      <RegistryField />
    </>
  );
}
