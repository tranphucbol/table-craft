import { useId, useState } from "react";
import type { CatalogPlugin, PluginInfo, PluginInstallState } from "@table-craft/desktop/preload/bridge.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { ActionIcon } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  PLUGIN_ACTION_IDS,
  type PackageArgs,
  type PluginArgs,
  type PluginRemoveArgs,
} from "@table-craft/desktop/renderer/actions/pluginActions.js";
import { Button, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  LOOSE_GRID_CLASS,
  LooseNote,
  LooseRow,
  LooseTitle,
} from "@table-craft/desktop/renderer/dialogs/pluginsParts.js";
import { RegistriesSection } from "@table-craft/desktop/renderer/dialogs/RegistriesSection.js";
import {
  downloadLabel,
  installText,
  registryLabel,
  registryOfPlugin,
  registryUpdateFailure,
  unavailableText,
} from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { DatasourceGlyph } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";
import { isScopedPackageName, packageScope } from "@table-craft/desktop/settings/settings.js";

function InstallStatus({ text, install }: { readonly text: string | null; readonly install: PluginInstallState }) {
  if (text === null) return null;
  const failed = install.status === "failed";
  return (
    <span
      role={failed ? "alert" : "status"}
      title={install.status === "failed" ? install.hint : undefined}
      className={cn("truncate", failed ? "text-danger" : "text-ink-muted")}
    >
      {text}
    </span>
  );
}

function Progress({ entry }: { readonly entry: CatalogPlugin | undefined }) {
  if (entry === undefined) return null;
  return <InstallStatus text={installText(entry)} install={entry.install} />;
}

function RowIconButton({
  label,
  icon,
  danger = false,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: ActionIcon;
  readonly danger?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const Icon = ACTION_ICONS[icon];
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        className={cn(ICON_BUTTON, danger && "enabled:hover:text-danger")}
        onClick={onClick}
      >
        <Icon aria-hidden className="size-icon" />
      </button>
    </Tooltip>
  );
}

function InstalledRow({ plugin, entry }: { readonly plugin: PluginInfo; readonly entry: CatalogPlugin | undefined }) {
  const registries = useDatasources((state) => state.registries);
  const registryRemoved = useDatasources((state) => state.registryRemoved);
  const args: PluginArgs = { pluginId: plugin.id };
  const removeArgs: PluginRemoveArgs = { pluginId: plugin.id, source: plugin.source === "user" ? "user" : "managed" };
  const busy = entry?.install.status === "installing";
  const registryFailure = registryUpdateFailure(registryOfPlugin(registries, plugin.id), entry?.install);
  return (
    <LooseRow label={plugin.name}>
      <span data-plugin-row={plugin.id} className="flex min-w-0 items-center gap-cell">
        <DatasourceGlyph brand={plugin.brands[0] ?? null} className="size-icon shrink-0" />
        <span className="shrink-0">{plugin.version ?? ""}</span>
        <span className="shrink-0 text-ink-muted">{registryLabel(plugin, registries, registryRemoved)}</span>
        {plugin.unavailableReason === null ? null : (
          <span title={plugin.unavailableReason} className="truncate text-danger">
            {unavailableText(plugin)}
          </span>
        )}
        {registryFailure !== null ? (
          <span
            role="alert"
            title={entry?.install.status === "failed" ? `${entry.install.message} ${entry.install.hint}` : undefined}
            className="truncate text-danger"
          >
            {registryFailure}
          </span>
        ) : (
          <Progress entry={entry} />
        )}
        {plugin.source === "managed" && entry !== undefined ? (
          <RowIconButton
            label="Update"
            icon="update"
            disabled={busy}
            onClick={() => invoke(PLUGIN_ACTION_IDS.install, args)}
          />
        ) : null}
        {plugin.source === "managed" || plugin.source === "user" ? (
          <RowIconButton
            label="Remove"
            icon="delete"
            danger
            disabled={busy}
            onClick={() => invoke(PLUGIN_ACTION_IDS.remove, removeArgs)}
          />
        ) : null}
      </span>
    </LooseRow>
  );
}

function DownloadRow({ entry }: { readonly entry: CatalogPlugin }) {
  const args: PluginArgs = { pluginId: entry.id };
  return (
    <LooseRow label={entry.name}>
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
    </LooseRow>
  );
}

/** Where a typed package would come from: "From Company registry (scope @acme)". */
function routeHint(packageName: string, registries: readonly { name: string; scopes: readonly string[] }[]): string {
  const scope = packageScope(packageName);
  const owner = scope === null ? undefined : registries.find((registry) => registry.scopes.includes(scope));
  if (owner !== undefined && scope !== null) return `From ${owner.name} (scope ${scope})`;
  const configured = registries.flatMap((registry) => registry.scopes);
  if (configured.length === 0) return "Add a registry below for the package’s scope first.";
  if (scope === null) return `A package of a scope a registry below serves: ${configured.join(", ")}.`;
  return `No registry below serves ${scope}; they serve ${configured.join(", ")}.`;
}

function PackageRow() {
  const id = useId();
  const [text, setText] = useState("");
  const registries = useSettings((state) => state.settings.plugins.registries);
  const packageInstalls = useDatasources((state) => state.packageInstalls);
  const packageName = text.trim();
  const valid = isScopedPackageName(packageName);
  const routed = valid && registries.some((registry) => registry.scopes.includes(packageScope(packageName) ?? ""));
  const install = packageInstalls.find((candidate) => candidate.packageName === packageName)?.install;
  const args: PackageArgs = { packageName };
  const status =
    install === undefined || install.status === "idle"
      ? null
      : install.status === "failed"
        ? install.message
        : `Installing ${packageName}…`;
  return (
    <LooseRow label="By package name" htmlFor={id} hint={routeHint(packageName, registries)}>
      <TextInput
        id={id}
        className="min-w-0 flex-1"
        placeholder="@scope/package-name"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && routed) invoke(PLUGIN_ACTION_IDS.installPackage, args);
        }}
      />
      {install === undefined ? null : <InstallStatus text={status} install={install} />}
      <Button
        disabled={!routed || install?.status === "installing"}
        onClick={() => invoke(PLUGIN_ACTION_IDS.installPackage, args)}
      >
        Install…
      </Button>
    </LooseRow>
  );
}

/** Settings → Plugins: what is installed and from where, what can be downloaded, and the registries. */
export function PluginsPage() {
  const plugins = useDatasources((state) => state.plugins);
  const catalog = useDatasources((state) => state.catalog);
  const downloadable = catalog.filter((entry) => !plugins.some((plugin) => plugin.id === entry.id));
  return (
    <div className={cn("col-span-2", LOOSE_GRID_CLASS)}>
      <LooseTitle>Installed</LooseTitle>
      {plugins.map((plugin, index) => (
        <InstalledRow
          key={`${String(index)}:${plugin.id}`}
          plugin={plugin}
          entry={catalog.find((candidate) => candidate.id === plugin.id)}
        />
      ))}
      <LooseNote>Downloaded plugins update in the background while “Check for updates automatically” is on.</LooseNote>
      <LooseTitle>Available</LooseTitle>
      {downloadable.length === 0 ? (
        <LooseNote>Every plugin TableCraft offers is installed.</LooseNote>
      ) : (
        downloadable.map((entry) => <DownloadRow key={entry.id} entry={entry} />)
      )}
      <PackageRow />
      <RegistriesSection />
      <LooseTitle>From a file</LooseTitle>
      <LooseRow
        label="Package"
        hint="For a machine without the registry: a plugin’s .tgz from the release page. A plugin runs with TableCraft’s access to your files and network, so install only ones you trust."
      >
        <ActionButton actionId={PLUGIN_ACTION_IDS.installFile} />
      </LooseRow>
    </div>
  );
}
