# Writing plugins

For plugin authors: what a manifest declares, the contract suite a plugin should pass, and how the plugin API stays compatible. To install or manage plugins, see [Plugins](plugins.md).

## Capabilities

The manifest declares what the plugin can do, and the UI offers only what it declares:

- `sql`: runs one statement and returns rows or a row count; the plugin also supplies the SQL
  language (splitting, classifying, completion).
- `cancel`: stops a running statement.
- `schemaTree`: lists schemas and describes tables, views, columns, keys and indexes.
- `transactions`: switches between auto-commit and manual transactions, commits and rolls back.
- `ddl`: returns the definition of a table or view.
- `explain`: returns the plan of a statement without running it.
- `explainAnalyze`: runs a statement and returns its plan with actual rows and times.
- `currentNamespace`: reports which database or schema a console is in, so completion follows
  `USE` and `SET search_path`.
- `keepAlive`: turns on TCP keepalive when asked and answers a ping, so an idle console notices a
  dropped connection and reconnects.
- `bulkInsert`: writes batches of rows from an imported file and proposes and creates a table for
  one; requires `transactions`.
- `objects`: writes the DDL that creates, modifies, renames, truncates and drops tables and other
  objects from the database tree; requires `sql` and `schemaTree`.
- `serverMessages`: returns the warnings and notices the server left about a statement, which
  Output lists under it and the result tab counts.
- `sessions`: lists the server's sessions with who blocks whom, and cancels or terminates one, for
  the [Sessions](monitoring.md#sessions) view; requires `sql` or `commands`, and `schemaTree` or `keyValue`.
- `routineCall`: writes the statements that call a function or procedure with the values from
  [Execute Routine](explorer.md#execute-a-routine), OUT values included; requires `sql` and `schemaTree`.
- `commands`: runs one command of a command language such as Redis's and returns its reply; the
  plugin also supplies the language (splitting, classifying, completion). A plugin declares
  either `sql` or `commands`, never both.
- `keyValue`: lists databases and scans keys for the key tree, reads a key into a tab and applies
  guarded edits to it; requires `commands`.
- `nodes`: lists the nodes of a cluster, so a console can run a command on one node or on every
  primary; requires `sql` or `commands`.
- `serverInfo`: reports the server's statistics and slow log for the Server tab; requires `sql`
  or `commands`.
- `serverTimeout`: says what the connected server stops by itself and hands it the statement
  timeout, so the database stops a statement even when TableCraft cannot; requires `cancel`.
- `revisions`: reads a key at an earlier revision for history, diff and restore.
- `watch`: follows changes to a key or range from now or a past revision, with explicit gaps.
- `leases`: lists leases with keys and TTL, grants, renews and revokes them.
- `access`: lists and changes users, roles and permissions, and manages authentication where safe.
- `members`: lists configured endpoints and cluster members, and promotes or removes a member.
- `maintenance`: reports status and alarms, compacts, defragments, snapshots and checks consistency.
- `coordination`: shows holders and queues under configured lock and election prefixes.
- `bulkTransfer`: exports a range and imports chunk-atomically, resuming only confirmed boundaries.

```json
{
  "id": "postgres",
  "name": "PostgreSQL",
  "version": "0.0.0",
  "apiVersion": "1.10.0",
  "entry": "index.js",
  "capabilities": [
    "sql",
    "cancel",
    "schemaTree",
    "transactions",
    "ddl",
    "explain",
    "explainAnalyze",
    "currentNamespace",
    "keepAlive",
    "bulkInsert",
    "objects",
    "serverMessages",
    "sessions",
    "routineCall",
    "serverTimeout"
  ],
  "highlight": "postgresql",
  "brands": [{ "id": "postgresql", "name": "PostgreSQL" }],
  "connection": {
    "fields": [
      { "key": "host", "label": "Host", "kind": "text", "default": "localhost", "required": true },
      { "key": "password", "label": "Password", "kind": "password", "secret": true }
    ],
    "url": {
      "schemes": ["postgresql", "postgres"],
      "form": "server",
      "parts": { "host": "host", "password": "password" }
    },
    "network": { "host": "host", "port": "port", "connectTimeout": "connectTimeout" }
  }
}
```

`brands` lists the database products the plugin speaks, the default first; each `id` is a
[Simple Icons](https://simpleicons.org) slug, which picks the logo TableCraft draws, and `name` is
what the picker and the tree call it. The New Data Source picker lists one row per brand, and a
session's `serverBrand` says which one the server is.

`connection.network` names the fields that hold the server's address (a text host, a number port and
optionally a number of seconds to wait). A plugin that declares it gets the SSH tunnel: TableCraft
opens the tunnel and hands the plugin `127.0.0.1` and the forwarded port in those fields, so the
plugin itself knows nothing about SSH.

`connection.tls` names the SSL fields (`mode`, a select offering every one of `verifyModes`, and
optionally the `caFile`, `certFile` and `keyFile` file fields and the `keyPassphrase` secret). The
dialog draws them under SSL, asks for the passphrase only when the key file is encrypted, and shows
the session's `tls` (protocol and cipher) after Test Connection. Through a tunnel `connect` gets the
configured host as `serverName`, which a `verify-full` check must use instead of `127.0.0.1`.

A plugin's result columns may name their type class (`typeClass`: `integer`, `float`, `decimal`,
`boolean`, `temporal`, `json`, `bytes` or `text`), which then decides how the grid aligns, sorts
and exports them ahead of the type name; SQL Server's `bit`, for one, is a boolean.

The shared SQL kit in `@table-craft/plugin-api/sql` also reads Oracle and SQL Server scripts when a
plugin turns on their dialect options: `[bracketed]` names, `q'[…]'` and `N'…'` strings, `GO` and
`/` separator lines, and `:1` or `@p1` placeholders.

A plugin depends on `@tablecraft-app/plugin-api` and should pass its contract suite,
`runPluginContract` from `@table-craft/plugin-api/testing`, which the built-in plugins run against
real databases. See [Plugin contract](../design/specification.md#plugin-contract).

## Plugin compatibility

The plugin API follows semver and stays backward compatible within a major version:

- Set `apiVersion` to the version of `@tablecraft-app/plugin-api` you built against. TableCraft with
  plugin API `1.z` loads a plugin built for `1.y` when `y` is `z` or lower. A plugin built for a
  newer minor, or another major, is listed as unavailable with the plugin API it needs.
- A minor version only adds: new exports, new optional fields and methods, new capabilities. New
  contract tests apply only to plugins that declare what they test.
- Breaking changes wait for the next major: removing or renaming anything, making something
  optional required, adding a required member to what a plugin implements or returns, adding a
  value to what a plugin receives without an opt-in, or changing what a field means.
- Before removal, a member is marked `@deprecated` with its replacement for at least one major.
- A new optional method is called only when your plugin has it or declares its capability, never
  because of your `apiVersion`.

Plugins built for plugin API 0.x must be rebuilt for 1.0.
