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
(see [etcd](etcd.md))
([decision 108](../decisions/108-sqlite-and-mysql-ship-other-plugins-download.md)).

- **Data Sources +** lists PostgreSQL, Redis, Oracle, SQL Server and etcd with **Download**. Choosing it
  shows the progress, then the connection form.
- A saved data source whose plugin is missing shows greyed in the Database pane with **Install**.
  After an update from a version that had PostgreSQL built in, TableCraft installs it in the
  background on the first start, with no question.
- **Settings → Plugins** lists the built-in plugins, the downloaded ones with their version,
  **Update** and **Remove** (refused while a data source uses the plugin, naming it), and your
  own. With **Check for updates automatically** on, downloaded plugins are checked once a day and
  a newer compatible version is used from the next connection.
- Offline, or behind a firewall: every release attaches the plugin `.tgz` files. Choose **Install
  from File…** in Settings → Plugins; TableCraft asks before installing any file.
- Behind a corporate npm mirror, set its address in Settings → Plugins (`plugins.registryUrl`).

![Plugins on demand](../media/plugins.gif)

TableCraft installs the newest release its plugin API accepts (a beta too, with **Get beta
versions** checked in Settings → Advanced), refuses a download whose sha512
does not match the registry's, and keeps each version in `managed-plugins/` in the profile folder
([decision 110](../decisions/110-the-app-installs-plugins-from-the-registry.md)).

To write a plugin of your own, see [Writing plugins](writing-plugins.md).
