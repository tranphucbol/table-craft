# Plugins

A plugin is a folder with a `table-craft-plugin.json` manifest and an ES module. The built-in
plugins ship inside the app, others TableCraft offers
[download on demand](#databases-in-the-box-and-on-demand); your own go in `plugins/<id>/` in the
[profile folder](data-and-privacy.md) and load the same way. A plugin that fails to load is
listed as unavailable with the reason; the app keeps running.

## Databases in the box and on demand

SQLite and MySQL (with MariaDB and TiDB) ship inside the app and work offline from the first
launch. PostgreSQL is a plugin TableCraft downloads when you need it, about 190 KB, from npm as
[`@tablecraft-app/plugin-postgres`](https://www.npmjs.com/package/@tablecraft-app/plugin-postgres).
Redis downloads the same way, about 290 KB, as
[`@tablecraft-app/plugin-redis`](https://www.npmjs.com/package/@tablecraft-app/plugin-redis),
Oracle, about 360 KB, as
[`@tablecraft-app/plugin-oracle`](https://www.npmjs.com/package/@tablecraft-app/plugin-oracle), and
SQL Server (2017 and later, and Azure SQL), about 760 KB, as
[`@tablecraft-app/plugin-mssql`](https://www.npmjs.com/package/@tablecraft-app/plugin-mssql), and
etcd (3.5 and later), about 400 KB, as
[`@tablecraft-app/plugin-etcd`](https://www.npmjs.com/package/@tablecraft-app/plugin-etcd)
(see [etcd](etcd.md)), and DuckDB, about 29 MB because it carries DuckDB itself, as
`@tablecraft-app/plugin-duckdb` followed by the system, such as
[`@tablecraft-app/plugin-duckdb-darwin-arm64`](https://www.npmjs.com/package/@tablecraft-app/plugin-duckdb-darwin-arm64)
(see [DuckDB](duckdb.md); macOS, Windows and Linux on x64 and arm64)
([decision 108](../decisions/108-sqlite-and-mysql-ship-other-plugins-download.md),
[decision 156](../decisions/156-native-drivers-ship-one-package-per-platform.md)).

- **Data Sources +** lists PostgreSQL, Redis, Oracle, SQL Server, etcd and DuckDB with **Download**. Choosing it
  shows the progress, then the connection form.
- A saved data source whose plugin is missing shows greyed in the Database pane with **Install**.
  After an update from a version that had PostgreSQL built in, TableCraft installs it in the
  background on the first start, with no question.
- A downloaded plugin built for an older plugin API than this TableCraft cannot run, so it is
  treated as missing: TableCraft downloads the build for this version as soon as it starts, even
  with automatic checks off, and the data source shows **Updating…**. Connecting waits for it. If
  the download fails, the data source shows **Update failed** with **Retry**, and connecting says
  the plugin must be updated. A plugin you built or installed from a file is left alone and listed
  as unavailable until you rebuild it.
- A plugin built for a newer plugin API shows **Needs a newer TableCraft**, with **Check for
  Updates**.
- **Settings → Plugins** lists the built-in plugins, the downloaded ones with their version,
  **Update** and **Remove** (refused while a data source uses the plugin, naming it), and your
  own. With **Check for updates automatically** on, downloaded plugins are checked every 2 hours and
  a newer compatible version is used from the next connection.
- Offline, or behind a firewall: every release attaches the plugin `.tgz` files. Choose **Install
  from File…** in Settings → Plugins; TableCraft asks before installing any file, and refuses a
  DuckDB file built for another system, naming the one to pick.
- Behind a corporate npm mirror, set its address in Settings → Plugins (`plugins.registryUrl`).

![Plugins on demand](../media/plugins.gif)

TableCraft installs the newest release its plugin API accepts (a beta too, with **Get beta
versions** checked in Settings → Advanced), refuses a download whose sha512
does not match the registry's, and keeps each version in `managed-plugins/` in the profile folder
([decision 110](../decisions/110-the-app-installs-plugins-from-the-registry.md)).

## Private registries

A plugin your company publishes to its own npm registry, such as GitLab's package registry,
installs from there by its scope, while official plugins keep coming from npm.

- In **Settings → Plugins → Registries**, choose **+ Add registry** and fill in a name, the
  registry's npm address, such as `https://gitlab.example.com/api/v4/packages/npm`, its scopes,
  such as `@acme`, and a token. For GitLab, a personal or group access token with `read_api`.
  **Test connection** checks the address and the token before you save. A scope belongs to one
  registry, and `@tablecraft-app` always comes from npm.
- The token is kept encrypted by the system keychain, never in `settings.json`, never shown again,
  and sent only to the registry's own host: a download that leaves it goes without the token.
- Under **Available**, type the package name, such as `@acme/tablecraft-plugin-example`, and
  choose **Install…**. TableCraft picks the newest version this TableCraft can run, shows what it
  adds and asks once before installing a package from a private registry. Updates come from the
  same registry without asking again.
- GitLab publishes only a sha-1 checksum, which TableCraft checks for a private registry; a
  package from npm still needs its sha512.
- A refused token turns the registry's card red; paste a new one there. Removing a registry
  forgets its token and keeps its plugins installed, but they stop updating.

To write a plugin of your own, see [Writing plugins](writing-plugins.md).
