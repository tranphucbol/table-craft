# Writing plugins

For plugin authors: what a manifest declares, the contract suite a plugin should pass, and how the plugin API stays compatible. To install or manage plugins, see [Plugins](plugins.md).

## Capabilities

The manifest declares what the plugin can do, and the UI offers only what it declares. Each
capability is a key: what it brings lives under that key of `session.services` (what `connect`
returns), of `language.services`, or is the plugin's `language` or `commandLanguage`. A key is
present exactly when the capability is declared, both ways; TableCraft checks this when it loads
the plugin and on every session it opens, and refuses a plugin that breaks it. A flag brings no
service.

| Capability         | What it does                                                                                                                                                                                                            | Where it lives                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `sql`              | Runs one statement and returns rows or a row count; the plugin also supplies the SQL language (splitting, classifying, completion).                                                                                     | `plugin.language`                                                         |
| `cancel`           | Stops a running statement, and says what the stop reaches.                                                                                                                                                              | `session.services.cancel`                                                 |
| `schemaTree`       | Lists schemas and describes tables, views, columns, keys and indexes.                                                                                                                                                   | `session.services.schemaTree`                                             |
| `transactions`     | Switches between auto-commit and manual transactions, commits and rolls back.                                                                                                                                           | `session.services.transactions`                                           |
| `ddl`              | Returns the definition of a table or view; requires `schemaTree`.                                                                                                                                                       | `session.services.ddl`                                                    |
| `explain`          | Returns the plan of a statement without running it; requires `sql`.                                                                                                                                                     | `session.services.explain`, `language.services.explain`                   |
| `explainAnalyze`   | Runs a statement and returns its plan with actual rows and times; requires `explain`.                                                                                                                                   | flag                                                                      |
| `currentNamespace` | Reports which database or schema a console is in, so completion follows `USE` and `SET search_path`; requires `sql`.                                                                                                    | `session.services.currentNamespace`, `language.services.currentNamespace` |
| `keepAlive`        | Turns on TCP keepalive when asked and answers a ping, so an idle console notices a dropped connection and reconnects.                                                                                                   | `session.services.keepAlive`                                              |
| `bulkInsert`       | Writes batches of rows from an imported file and proposes and creates a table for one; requires `transactions`.                                                                                                         | `session.services.bulkInsert`, `language.services.bulkInsert`             |
| `objects`          | Writes the DDL that creates, modifies, renames, truncates and drops tables and other objects from the database tree; requires `sql` and `schemaTree`.                                                                   | `language.services.objects`                                               |
| `serverMessages`   | Returns the warnings and notices the server left about a statement, which Output lists under it and the result tab counts.                                                                                              | flag                                                                      |
| `sessions`         | Lists the server's sessions with who blocks whom, and cancels or terminates one, for the [Sessions](monitoring.md#sessions) view; requires `sql` or `commands`, and `schemaTree` or `keyValue`.                         | `session.services.sessions`                                               |
| `routineCall`      | Writes the statements that call a function or procedure with the values from [Execute Routine](explorer.md#execute-a-routine), OUT values included; requires `sql` and `schemaTree`.                                    | `language.services.routineCall`                                           |
| `commands`         | Runs one command of a command language such as Redis's and returns its reply; the plugin also supplies the language (splitting, classifying, completion). A plugin declares either `sql` or `commands`, never both.     | `plugin.commandLanguage`                                                  |
| `keyValue`         | Lists databases and scans keys for the key tree, reads a key into a tab and applies guarded edits to it; requires `commands`.                                                                                           | `session.services.keyValue`                                               |
| `nodes`            | Lists the nodes of a cluster, so a console can run a command on one node or on every primary; requires `sql` or `commands`.                                                                                             | `session.services.nodes`                                                  |
| `serverInfo`       | Reports the server's statistics and slow log for the Server tab; requires `sql` or `commands`.                                                                                                                          | `session.services.serverInfo`                                             |
| `serverTimeout`    | Says what the connected server stops by itself and hands it the statement timeout, so the database stops a statement even when TableCraft cannot; requires `cancel`. A server without such a setting has `limit: null`. | `session.services.serverTimeout`                                          |
| `revisions`        | Reads a key at an earlier revision for history, diff and restore.                                                                                                                                                       | flag                                                                      |
| `watch`            | Follows changes to a key or range from now or a past revision, with explicit gaps.                                                                                                                                      | `session.services.watch`                                                  |
| `leases`           | Lists leases with keys and TTL, grants, renews and revokes them.                                                                                                                                                        | `session.services.leases`                                                 |
| `access`           | Lists and changes users, roles and permissions, and manages authentication where safe.                                                                                                                                  | `session.services.access`                                                 |
| `members`          | Lists configured endpoints and cluster members, and promotes or removes a member.                                                                                                                                       | `session.services.members`                                                |
| `maintenance`      | Reports status and alarms, compacts, defragments, snapshots and checks consistency.                                                                                                                                     | `session.services.maintenance`                                            |
| `coordination`     | Shows holders and queues under configured lock and election prefixes.                                                                                                                                                   | `session.services.coordination`                                           |
| `bulkTransfer`     | Exports a range and imports chunk-atomically, resuming only confirmed boundaries.                                                                                                                                       | `session.services.bulkTransfer`                                           |

Write the default export with `definePlugin` and its capabilities `as const`: the types then
require exactly the declared keys on the session and the language, and type `connect`'s
configuration from the connection schema.

```ts
import { definePlugin, type PluginSession } from "@tablecraft-app/plugin-api";

const CAPABILITIES = ["sql", "cancel", "schemaTree", "transactions"] as const;
type Capability = (typeof CAPABILITIES)[number];

class Connection implements PluginSession<Capability> {
  readonly services: PluginSession<Capability>["services"] = {
    cancel: { cancel: () => this.#cancel(), reach: { method: "cancel request", reaches: "statement" } },
    schemaTree: introspector,
    transactions: transactions,
  };
  // execute, close, serverVersion …
}

export default definePlugin({
  id: "example",
  capabilities: CAPABILITIES,
  connectionSchema,
  connect: async (config) => new Connection(await open(connectionSchema.parse(config))),
  language,
});
```

```json
{
  "id": "postgres",
  "name": "PostgreSQL",
  "version": "0.0.0",
  "apiVersion": "2.0.0",
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
  plugin API `2.z` loads a plugin built for `2.y` when `y` is `z` or lower. A plugin built for a
  newer minor, or another major, is listed as unavailable with the plugin API it needs.
- A minor version only adds: new exports, new optional fields and methods, new capabilities. New
  contract tests apply only to plugins that declare what they test.
- Breaking changes wait for the next major: removing or renaming anything, making something
  optional required, adding a required member to what a plugin implements or returns, adding a
  value to what a plugin receives without an opt-in, or changing what a field means.
- Before removal, a member is marked `@deprecated` with its replacement for at least one major.
- A new optional method is called only when your plugin has it or declares its capability, never
  because of your `apiVersion`.

## From 1.x to 2.0

Plugin API 2.0 groups everything a capability brings under its key. TableCraft on plugin API 2.0 refuses a
plugin built for 1.x; the plugins it downloads update themselves, and one you built or installed
from a file shows "Rebuild it for plugin API 2.x". To move a plugin:

- Set `apiVersion` to `2.0.0` and wrap the default export in `definePlugin`, with the capabilities
  `as const`.
- Move each flat session member under its capability in `services`: `cancel()` and `cancelReach`
  become `services.cancel` (`cancel`, `reach`); `introspector` becomes `services.schemaTree`, and
  its `definition` moves to `services.ddl`; `transactions`, `keyspace` (now `keyValue`),
  `keyTransfer` (now `bulkTransfer`), `watch`, `leases`, `access` and `coordination` move as they
  are; `ping()`, `insertRows()`, `explain()`, `currentNamespace()`, `nodes()` become `keepAlive.ping`,
  `bulkInsert.insertRows`, `explain.explain`, `currentNamespace.current` and `nodes.list`;
  `serverInfo()` and `slowLog()` become `serverInfo.info` and `serverInfo.slowLog`; `sessions`,
  `serverSessionId`, `serverInstance` and `findServerInstance()` become `services.sessions` with
  `ownId`, `ownInstance` and `findOwnInstance()`; `serverTimeout` becomes `services.serverTimeout`
  with `limit` (`null` when the server has no such setting); `cluster` splits into `members` and
  `maintenance`.
- Move the language's optional members under `language.services`: `explainable` to
  `explain.explainable`, `namespaceSwitch` to `currentNamespace`, `importType` and `createTable`
  to `bulkInsert`, `objects` and `routineCall` (now `routineCall.call`) as they are.
- Implement what became required: `splitStream`, `signatureAt`, `inspect`, `selectSource` and
  `savepoint` on the language, `reach` on `cancel`, `slowLog` on `serverInfo`. The SQL kit's
  `sqlStatementStream`, `sqlCompleter`, `sqlInspector` and `sqlSavepoints` supply them.
- Leave out every key you do not declare: a service without its capability is refused like a
  capability without its service. `serviceProblems` in `@tablecraft-app/plugin-api` says what the
  check finds, and the contract suite runs it.
