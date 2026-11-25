# Writing plugins

A plugin declares what it can do in its manifest, should pass the contract suite, and builds on a
plugin API that stays backward compatible within a major version. To install or manage plugins, see
[Plugins](plugins.md).

## Capabilities

The manifest declares what the plugin can do, and the UI offers only what it declares. Each
capability is a key. What it brings lives under that key of `session.services` (what `connect`
returns) or of `language.services`, or it is the plugin's `language` or `commandLanguage`. A flag
brings no service.

A key is present exactly when its capability is declared, and the other way round. TableCraft
checks this when it loads the plugin and on every session it opens, and refuses a plugin that
breaks it.

| Capability         | What it does                                                                                                                                                                                                                                                                                        | Where it lives                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `sql`              | Runs one statement and returns rows or a row count; the plugin also supplies the SQL language (splitting, classifying, completion).                                                                                                                                                                 | `plugin.language`                                                         |
| `cancel`           | Stops a running statement, and says what the stop reaches.                                                                                                                                                                                                                                          | `session.services.cancel`                                                 |
| `schemaTree`       | Lists schemas and describes tables, views, columns, keys and indexes.                                                                                                                                                                                                                               | `session.services.schemaTree`                                             |
| `transactions`     | Switches between auto-commit and manual transactions, commits and rolls back.                                                                                                                                                                                                                       | `session.services.transactions`                                           |
| `ddl`              | Returns the definition of a table or view; requires `schemaTree`.                                                                                                                                                                                                                                   | `session.services.ddl`                                                    |
| `explain`          | Returns the plan of a statement without running it; requires `sql`.                                                                                                                                                                                                                                 | `session.services.explain`, `language.services.explain`                   |
| `explainAnalyze`   | Runs a statement and returns its plan with actual rows and times; requires `explain`.                                                                                                                                                                                                               | flag                                                                      |
| `currentNamespace` | Reports which database or schema a console is in, so completion follows `USE` and `SET search_path`; requires `sql`.                                                                                                                                                                                | `session.services.currentNamespace`, `language.services.currentNamespace` |
| `keepAlive`        | Turns on TCP keepalive when asked and answers a ping, so an idle console notices a dropped connection and reconnects.                                                                                                                                                                               | `session.services.keepAlive`                                              |
| `bulkInsert`       | Writes batches of rows from an imported file and proposes and creates a table for one; requires `transactions`.                                                                                                                                                                                     | `session.services.bulkInsert`, `language.services.bulkInsert`             |
| `objects`          | Writes the DDL that creates, modifies, renames, truncates and drops tables and other objects from the database tree; requires `sql` and `schemaTree`.                                                                                                                                               | `language.services.objects`                                               |
| `serverMessages`   | Returns the warnings and notices the server left about a statement, which Output lists under it and the result tab counts.                                                                                                                                                                          | flag                                                                      |
| `sessions`         | Lists the server's sessions with who blocks whom, and cancels or terminates one, for the [Sessions](monitoring.md#sessions) view; requires `sql` or `commands`, and `schemaTree` or `keyValue`.                                                                                                     | `session.services.sessions`                                               |
| `routineCall`      | Writes the statements that call a function or procedure with the values from [Execute Routine](explorer.md#execute-a-routine), OUT values included; requires `sql` and `schemaTree`.                                                                                                                | `language.services.routineCall`                                           |
| `commands`         | Runs one command of a command language such as Redis's and returns its reply; the plugin also supplies the language (splitting, classifying, completion). A plugin declares either `sql` or `commands`, never both.                                                                                 | `plugin.commandLanguage`                                                  |
| `keyValue`         | Lists databases and scans keys for the key tree, reads a key into a tab and applies guarded edits to it; requires `commands`.                                                                                                                                                                       | `session.services.keyValue`                                               |
| `nodes`            | Lists the nodes of a cluster, so a console can run a command on one node or on every primary; requires `sql` or `commands`.                                                                                                                                                                         | `session.services.nodes`                                                  |
| `serverInfo`       | Reports the server's statistics and slow log for the Server tab; requires `sql` or `commands`.                                                                                                                                                                                                      | `session.services.serverInfo`                                             |
| `serverTimeout`    | Says what the connected server stops by itself and hands it the statement timeout, so the database stops a statement even when TableCraft cannot; needs no `cancel`. A server without such a setting has `limit: null`.                                                                             | `session.services.serverTimeout`                                          |
| `revisions`        | Reads a key at an earlier revision for history, diff and restore.                                                                                                                                                                                                                                   | flag                                                                      |
| `watch`            | Follows changes to a key or range from now or a past revision, with explicit gaps.                                                                                                                                                                                                                  | `session.services.watch`                                                  |
| `leases`           | Lists leases with keys and TTL, grants, renews and revokes them.                                                                                                                                                                                                                                    | `session.services.leases`                                                 |
| `access`           | Lists and changes users, roles and permissions, and manages authentication where safe.                                                                                                                                                                                                              | `session.services.access`                                                 |
| `members`          | Lists configured endpoints and cluster members, and promotes or removes a member.                                                                                                                                                                                                                   | `session.services.members`                                                |
| `maintenance`      | Reports status and alarms, compacts, defragments, snapshots and checks consistency.                                                                                                                                                                                                                 | `session.services.maintenance`                                            |
| `coordination`     | Shows holders and queues under configured lock and election prefixes.                                                                                                                                                                                                                               | `session.services.coordination`                                           |
| `bulkTransfer`     | Exports a range and imports chunk-atomically, resuming only confirmed boundaries.                                                                                                                                                                                                                   | `session.services.bulkTransfer`                                           |
| `savepoints`       | Writes the savepoint statements that let console edits inside an open transaction undo only themselves when one is refused; requires `sql` and `transactions`.                                                                                                                                      | `language.services.savepoints`                                            |
| `rowLimit`         | Writes a row limit into a plain `SELECT`, so the server stops after one page; Fetch Next Page and Fetch All run it again with a larger limit; requires `sql`.                                                                                                                                       | `language.services.rowLimit`                                              |
| `topics`           | Lists, describes and reads topics without joining a consumer group, produces, administers topics and tails them live, for the stream tree and topic tabs; requires `commands`, excludes `schemaTree` and `keyValue`.                                                                                | `session.services.topics`                                                 |
| `consumerGroups`   | Lists and describes consumer groups with their lag, and previews and applies an offset reset by token; requires `commands`.                                                                                                                                                                         | `session.services.consumerGroups`                                         |
| `schemaRegistry`   | Lists subjects and versions of a schema registry, checks and registers schemas; answers `available: false` on a data source without a registry; requires `commands`.                                                                                                                                | `session.services.schemaRegistry`                                         |
| `searchIndices`    | Lists indices, aliases and data streams, describes their fields, searches with a Lucene or Query DSL query, a sort and a time range, counts, draws a histogram over time and analyzes text, for the index tree and index tabs; requires `commands`, excludes `schemaTree`, `keyValue` and `topics`. | `session.services.searchIndices`                                          |
| `databases`        | Lists connectable databases for the Manage Shown Schemas picker; requires `schemaTree` and a non-secret text field named by `url.parts.database`.                                                                                                                                                   | `session.services.databases`                                              |

### Write the default export

Write the default export with `definePlugin` and its capabilities `as const`. The types then
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

### Fill in the manifest

The manifest is `table-craft-plugin.json`. Here is PostgreSQL's, with most of its connection fields
left out:

```json
{
  "id": "postgres",
  "name": "PostgreSQL",
  "version": "0.0.0",
  "apiVersion": "2.4.0",
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
    "serverTimeout",
    "savepoints",
    "rowLimit"
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

- `brands`: the database products the plugin speaks, the default first. Each `id` is a
  [Simple Icons](https://simpleicons.org) slug, which picks the logo TableCraft draws, and `name` is
  what the picker and the tree call it. The New Data Source picker lists one row per brand, and a
  session's `serverBrand` says which one the server is.
- `connection.fields`: draws the connection form. A field's optional `hint` (plugin API 2.1) puts
  an (i) beside it. Say there what the field does, its unit, and what blank means, such as how a
  timeout applies.
- `connection.network`: names the fields that hold the server's address (a text host, a number
  port and optionally a number of seconds to wait). A plugin that declares it gets the SSH tunnel.
  TableCraft opens the tunnel and hands the plugin `127.0.0.1` and the forwarded port in those
  fields, so the plugin itself knows nothing about SSH.
- `connection.tls`: names the SSL fields (`mode`, a select offering every one of `verifyModes`, and
  optionally the `caFile`, `certFile` and `keyFile` file fields and the `keyPassphrase` secret).
  The dialog draws them under **SSL**, asks for the passphrase only when the key file is encrypted,
  and shows the session's `tls` (protocol and cipher) after **Test Connection**. Through a tunnel
  `connect` gets the configured host as `serverName`, which a `verify-full` check must use instead
  of `127.0.0.1`.

### Describe results

A plugin's result columns may name their type class (`typeClass`: `integer`, `float`, `decimal`,
`boolean`, `temporal`, `json`, `bytes` or `text`). The grid then aligns, sorts and exports them by
that class ahead of the type name; SQL Server's `bit`, for one, is a boolean.

A plugin that sends the server other text than `execute` was given, such as a statement with a
hint it added, returns that text as the result's `sent`, or passes `sent` to the `PluginError` it
throws (plugin API 2.1). The query history and Services then show what reached the server.

### Read Oracle and SQL Server scripts

The shared SQL kit in `@table-craft/plugin-api/sql` also reads Oracle and SQL Server scripts when a
plugin turns on their dialect options: `[bracketed]` names, `q'[…]'` and `N'…'` strings, `GO` and
`/` separator lines, and `:1` or `@p1` placeholders.

### Pass the contract suite

A plugin depends on `@tablecraft-app/plugin-api` and should pass its contract suite,
`runPluginContract` from `@table-craft/plugin-api/testing`. The built-in plugins run it against
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

## Publishing to a private registry

A plugin for your company alone can live in your own npm registry, such as GitLab's package
registry, instead of npm. To publish it there:

1. Name the package in a scope your registry serves, such as `@acme/tablecraft-plugin-example`.
2. Put `table-craft-plugin.json` and the built `index.js` in the package, and declare the plugin in
   `package.json`, as `scripts/plugins/pack.ts` does for the official ones. The id must not be a
   built-in or official plugin's id.

   ```json
   {
     "name": "@acme/tablecraft-plugin-example",
     "version": "1.0.0",
     "type": "module",
     "main": "index.js",
     "tableCraft": { "id": "example", "apiVersion": "2.4.0" }
   }
   ```

3. Publish it to the registry with `npm publish`.
4. Tell users the package name and the registry's address and scope. They add the registry as
   described in [Private registries](plugins.md#private-registries).

TableCraft reads `tableCraft` from the tarball when the registry leaves it out of the packument, as
GitLab does, and picks the newest version whose `apiVersion` it accepts. Pre-releases
(`1.1.0-beta.1`) install only for users on the beta channel.

## Licensing your plugin

TableCraft is GPL-3.0-or-later, and `@tablecraft-app/plugin-api` is MIT. A plugin that talks to
TableCraft only through the plugin API may use any license, open or closed: the
[plugin exception](../../LICENSE-EXCEPTION) grants that on top of the GPL. A plugin that imports
other TableCraft code, such as `@table-craft/core` or the desktop app, is a derivative of the GPL'd
code and must be GPL-3.0-or-later itself.

## From 1.x to 2.0

Plugin API 2.0 groups everything a capability brings under its key. TableCraft on plugin API 2.0
refuses a plugin built for 1.x. The plugins it downloads update themselves, and one you built or
installed from a file shows "Rebuild it for plugin API 2.x".

### Move a plugin to 2.0

1. Set `apiVersion` to `2.0.0` and wrap the default export in `definePlugin`, with the capabilities
   `as const`.
2. Move each flat session member under its capability in `services`:
   - `cancel()` and `cancelReach` become `services.cancel` (`cancel`, `reach`).
   - `introspector` becomes `services.schemaTree`, and its `definition` moves to `services.ddl`.
   - `transactions`, `keyspace` (now `keyValue`), `keyTransfer` (now `bulkTransfer`), `watch`,
     `leases`, `access` and `coordination` move as they are.
   - `ping()`, `insertRows()`, `explain()`, `currentNamespace()`, `nodes()` become
     `keepAlive.ping`, `bulkInsert.insertRows`, `explain.explain`, `currentNamespace.current` and
     `nodes.list`.
   - `serverInfo()` and `slowLog()` become `serverInfo.info` and `serverInfo.slowLog`.
   - `sessions`, `serverSessionId`, `serverInstance` and `findServerInstance()` become
     `services.sessions` with `ownId`, `ownInstance` and `findOwnInstance()`.
   - `serverTimeout` becomes `services.serverTimeout` with `limit` (`null` when the server has no
     such setting).
   - `cluster` splits into `members` and `maintenance`.
3. Move the language's optional members under `language.services`:
   - `explainable` to `explain.explainable`.
   - `namespaceSwitch` to `currentNamespace`.
   - `importType` and `createTable` to `bulkInsert`.
   - `objects` and `routineCall` (now `routineCall.call`) as they are.
   - `savepoint` to `savepoints.savepoint`, declaring `savepoints`.
4. Implement what became required: `splitStream`, `signatureAt`, `inspect`, and `selectSource` on
   the language, `reach` on `cancel`, `slowLog` on `serverInfo`. The SQL kit's
   `sqlStatementStream`, `sqlCompleter`, `sqlInspector` and `sqlSavepoints` supply them.
5. Leave out every key you do not declare. A service without its capability is refused like a
   capability without its service.

`serviceProblems` in `@tablecraft-app/plugin-api` says what that check finds, and the contract
suite runs it.
