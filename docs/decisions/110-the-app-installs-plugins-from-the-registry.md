# 110: The app installs plugins from the npm registry

Status: Accepted. Plan 057.

## Decision

Main installs, updates and removes optional plugins (decision 108) from an npm registry
(`main/pluginStore/`). The engine runs them as before (decisions 005, 006); only where they come
from changes.

- **Pick.** Read the packument (`<registry>/@tablecraft-app%2fplugin-<id>`) and take the newest
  release (`X.Y.Z`, no pre-release) whose `tableCraft.id` is the plugin's and whose
  `tableCraft.apiVersion` the host accepts (plugin-api's `incompatibility()`, the loader's own
  rule). When only newer API versions exist the error says to update TableCraft.
- **Download and verify.** The tarball is capped at 64 MiB and its `dist.integrity` (sha512 only)
  is checked before anything is unpacked. The reader accepts regular files under `package/` and
  refuses `..`, absolute or drive paths, backslashes, links and devices.
- **Install.** Files are staged in `<userData>/managed-plugins/<id>/.staging-<uuid>/`; the package
  name, version and `tableCraft.id` must match, and the manifest must pass the loader's discovery
  check. Only then is the folder renamed to `<userData>/managed-plugins/<id>/<version>/` and
  `<id>/current.json` (`{ version, packageName, source }`) written by temp file and rename. Any
  failure removes the staging folder and leaves the current version as it was. Versions other than
  `current`, staging leftovers and ids with no `current` are pruned at the next start.
- **Load.** Each managed plugin is a `{ directory }` plugin root, after the built-in and
  development roots and before `<userData>/plugins/`. Hosts and the datasource service read the
  roots through getters, so an install is used by the next engine boot with no restart; engines
  already running keep what they imported.
- **Registry.** `plugins.registryUrl` in `settings.json` (default `https://registry.npmjs.org`)
  serves corporate mirrors. It must be `https://`; plain `http://` only to `127.0.0.1`,
  `localhost` or `[::1]`, which is how the tests serve a loopback registry. Requests go through
  Electron's `net`, so the system proxy applies.
- **Trust.** Packages of the `@tablecraft-app` scope installed through the catalog are official: no
  prompt. Install from File (a `.tgz`) always asks decision 006's one-time confirmation in a
  native message box, naming the package and saying when it is not an official TableCraft plugin.
  A file install is never updated from the registry.
- **Updates.** A second `createUpdateSchedule` checks plugins installed from the registry when the
  app is packaged and `updates.checkAutomatically` is on (unpackaged only with
  `TABLE_CRAFT_PLUGIN_CHECK_MS`, the test seam). A newer compatible version installs beside the
  current one and becomes current; failures are silent, as the app update check is.
- **Missing plugins.** After the first window shows, every saved datasource whose plugin is
  missing and in the catalog starts an install with no prompt, so users upgrading from a version
  with PostgreSQL built in keep it. The row shows "Installing…", then the datasource; on failure
  it shows "Install failed" with Retry, and the hint points to Install from File. The import
  (plan 035) offers the same Install instead of a dead "unsupported" row.
- **Where the user meets it.** Data Sources **+** lists installed kinds and catalog entries with
  "Download (about N KB)"; choosing one downloads with progress, then opens the form.
  Settings → Plugins lists built-ins (locked), downloaded plugins (Update, Remove; Remove is
  refused while a datasource uses the plugin, naming it), user plugins, Install from File… and
  the registry address. Every command is an action (decision 015).

## Rationale

The managed folder is not under `<userData>/plugins/`, as the plan first said, because the loader
treats every folder of that root as a user plugin: version folders would load twice and clash.
A `current.json` pointer rather than a symlink works on Windows without privileges and is swapped
atomically by rename.

Checking integrity before unpacking, and unpacking into a staging folder, means a tampered or
truncated download never touches the profile. Main never imports plugin code (decision 019), so
its check before switching `current` is the manifest discovery check; CI's `plugins:check`
imports every published tarball through the real loader.

Pruning at start rather than when the last engine stops keeps the bookkeeping out of the engine
hosts; an engine started before an update keeps its imported module in memory, so removing its
folder at the next start is safe.

## Consequences

**Tests never reach the real registry.** `test/support/pluginRegistry.ts` serves packuments and
tarballs on loopback; the unit suites and `test/e2e/pluginsOnDemand.smoke.test.ts` use it.

**A plugin added to the catalog later** (plans 054, 055) gets the picker entry, the missing-plugin
row and the import's Install offer with no UI change.

**Offline first use of an optional plugin needs its `.tgz`.** Every release attaches them, and the
offline error says so.
