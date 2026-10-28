# TableCraft specification

A desktop database IDE modelled on JetBrains DataGrip, built with Electron, TypeScript and Bun.
This document describes what the app does; `docs/decisions/` records why.

## Scope

v1 is listed in decision 014. In short: PostgreSQL, MySQL and SQLite through runtime plugins
(SQLite and MySQL in the installer, PostgreSQL downloaded on demand, decision 108); connections with encrypted secrets; a database explorer; SQL consoles with autocomplete
and auto or manual commit; a virtualized result grid with export; CSV and TSV import; a table data editor; DDL;
query history; EXPLAIN; configurable themes, fonts and density.

## Processes

Main, one engine per connected datasource, and a sandboxed renderer that talks to each engine over
its own MessagePort (decision 002).

## Plugin contract

A plugin is a directory with `table-craft-plugin.json` and an ESM entry exporting a
`DatasourcePlugin` (decisions 005 to 008). The contract lives in `@table-craft/plugin-api`.
`API_VERSION` is `1.0.0` and follows semver (decision 106): a host on `1.z` loads a plugin built for
`1.y` when `y ≤ z`, whatever the patch, and refuses a newer minor or another major. Surface may only
grow within a major; `bun run api:check` and a frozen 1.0.0 SQLite plugin enforce it (decision 107).

### Discovery

The engine loads plugins from, in order: `<app>/resources/plugins/*` (built-ins); in a development
run only, `dist/optional-plugins/*`; each downloaded plugin's current version,
`<userData>/managed-plugins/<id>/<version>/`; then `<userData>/plugins/*`. A built-in plugin is
built into the first root and goes through the same loader as a user plugin. Each directory ends as
`loaded` or `unavailable` with a reason; nothing a plugin does stops the app.

| Failure                                                                       | Reason names        |
| ----------------------------------------------------------------------------- | ------------------- |
| No `table-craft-plugin.json` or unreadable JSON                               | the file            |
| Manifest fails the schema                                                     | every failing field |
| An earlier directory already claimed the id                                   | both directories    |
| `apiVersion` not compatible with the host                                     | the API it needs    |
| `entry` resolves outside the plugin directory                                 | the entry           |
| The entry throws on import, or its default export is not a `DatasourcePlugin` | the error           |
| The export's `id` or `capabilities` differ from the manifest                  | both values         |

### Distribution

SQLite and MySQL ship in the installer. Every other plugin TableCraft offers is optional
(`OPTIONAL_PLUGINS` in `vite.plugins.config.ts`, today PostgreSQL) and listed in a compiled-in
catalog (decision 108). Each release publishes it to npm as `@tablecraft-app/plugin-<id>` at the app's
version, with `"tableCraft": { "id", "apiVersion" }` in its `package.json`, and attaches the
`.tgz` to the GitHub release (decision 109).

Main installs one from the registry in `plugins.registryUrl` (default
`https://registry.npmjs.org`, `https://` only, plain `http://` only to this machine): the newest
release the host's API accepts, its sha512 `dist.integrity` checked before unpacking, every entry
inside `package/`, staged and checked before `current.json` points at it (decision 110). A new
plugin is used by the next engine that starts, with no restart.

| Where               | What the user sees                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Data Sources **+**  | installed kinds, then catalog entries with "Download (about N KB)"; a download shows progress, then the form             |
| Database pane       | a datasource whose plugin is missing, greyed, with Install (Retry after a failure)                                       |
| Import Data Sources | an unsupported row whose scheme a catalog plugin reads offers Install, then maps again                                   |
| Settings → Plugins  | built-ins (locked), downloaded (version, Update, Remove, refused while used), user plugins, Install from File…, registry |

On start, a saved datasource whose plugin is missing and in the catalog installs it in the
background with no prompt, so users upgrading from a version with PostgreSQL built in keep it.
Packaged, with `updates.checkAutomatically`, plugins installed from the registry are checked daily
and a newer compatible version becomes current for the next engine; older versions are pruned at
the next start. Install from File asks decision 006's confirmation and is never updated from the
registry. Offline, an install fails with a hint to use Install from File with the release's `.tgz`.

### Manifest

| Field          | Type                         | Meaning                                                                                                              |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`           | `^[a-z][a-z0-9-]*$`          | Unique across both roots; datasources refer to it                                                                    |
| `name`         | string                       | Shown before the entry is ever imported                                                                              |
| `version`      | semver                       | The plugin's own version                                                                                             |
| `apiVersion`   | semver                       | The `API_VERSION` it was built against; loads on the same major with an equal or later minor                         |
| `entry`        | relative path                | The ESM module, inside the directory                                                                                 |
| `capabilities` | `Capability[]`               | Must equal the export's                                                                                              |
| `highlight`    | string                       | The highlighter the console uses (decision 008)                                                                      |
| `connection`   | `{ fields, url?, network? }` | The connection form, at least one field (decision 019), its URL (decision 055) and its network fields (decision 070) |

No other field is accepted. Main reads manifests without importing plugin code, so the Data Sources
dialog lists every plugin, an unavailable one with its reason. A connection field is:

| Field         | Type                                                       | Meaning                                                                                                             |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `key`         | camelCase                                                  | The `connectionSchema` key it fills; unique                                                                         |
| `label`       | string                                                     | Shown beside the input                                                                                              |
| `kind`        | `text`, `number`, `password`, `file`, `select`, `checkbox` | The input; `file` adds Browse…, `select` needs `options`                                                            |
| `default`     | string, number or boolean                                  | Optional; prefilled in a new datasource                                                                             |
| `required`    | boolean                                                    | Optional; the dialog refuses to save it blank                                                                       |
| `placeholder` | string                                                     | Optional                                                                                                            |
| `options`     | `{ value, label }[]`                                       | For `select`                                                                                                        |
| `group`       | `general` or `advanced`                                    | Optional, `general` by default; Advanced is its own section                                                         |
| `secret`      | boolean                                                    | Kept by main per decision 020; required for `password`                                                              |
| `visibleWhen` | `{ key, equals }`                                          | Optional; the field shows, and counts as required, only while the named `select` or `checkbox` field holds `equals` |

`connection.url`, optional, is the URL the Data Sources dialog accepts pasted and "Copy as URL"
writes (decision 055):

| Field     | Type                                                   | Meaning                                                                                                                                        |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemes` | lowercase string[]                                     | Accepted schemes; the first is written                                                                                                         |
| `form`    | `server` or `file`                                     | `scheme://user:password@host:port/database?params`, or a path, `scheme:path` or `:memory:`                                                     |
| `parts`   | `{ host?, port?, database?, user?, password?, path? }` | The field key each part fills                                                                                                                  |
| `params`  | `{ name, key, values? }[]`                             | Optional; a query parameter, the field it fills and a map from URL value to field value                                                        |
| `sets`    | `{ <scheme>: { <field key>: value } }`                 | Optional; values a scheme sets when pasted (`rediss` sets TLS mode `require`); formatting picks the first scheme whose values the config holds |

`parseConnectionUrl(manifest, url)` from `@table-craft/plugin-api` returns `{ values, secrets,
ignored }` or throws `ConnectionUrlError`; `formatConnectionUrl(manifest, config)` never writes a
secret field or a parameter at its default. A parameter the manifest does not map, or a value
outside the field's options, lands in `ignored`. A `jdbc:` prefix is dropped, and libpq's `host`,
`port`, `dbname`, `user` and `password` parameters fill their parts.

`connection.network`, optional, is `{ host, port, connectTimeout? }`: the keys of a `text` field
holding the server's host, a `number` field holding its port and a `number` field of seconds to
wait for a connection. The schema refuses a key the form does not declare or a field of another
kind. A plugin that declares it offers the SSH tunnel (decision 070): core opens the tunnel and
passes `connect` a config whose host is `127.0.0.1` and whose port is the forwarded one. Without
it the Data Sources dialog shows no SSH section.

`connection.tls`, optional, is `{ mode, verifyModes, caFile?, certFile?, keyFile?, keyPassphrase? }`
(decision 072): `mode` a `select` field offering every value in `verifyModes`, the files `file`
fields and `keyPassphrase` a secret `password` field; the schema refuses anything else. The plugin
reads the files on connect; core only draws the fields, asks for the passphrase when the key file is
encrypted and, under a tunnel, passes the configured host as `ConnectOptions.serverName`.
`TlsSettingsError` (a `connectionFailed`) marks a failure the SSL settings can fix, and
`tlsFailureMessage`, `tlsFileMessage` and `tlsKeyMessage` word them the same way for every plugin.

### Capabilities

| Capability         | Promises                                                                                                                                                                                                                                                                        | Contract cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sql`              | `Session.execute` runs one statement; the plugin exports `language`                                                                                                                                                                                                             | select literals, statement without rows, rows affected, invalid SQL rejects `statementFailed`, session usable after a failure, `type_probe` cells, unshifted timestamps, early return; `language` splits the shared and fixture scripts into the expected statements, each of which executes, and classifies kinds and the destructive cases; an awkward identifier quotes and reads back, and each `type_probe` row written as `INSERT` literals into `type_probe_copy` reads back equal                                                                                                                                                                     |
| `transactions`     | `Session.transactions` switches auto and manual commit, commits, rolls back                                                                                                                                                                                                     | manual insert then rollback leaves no row and `open` false, manual insert then commit is visible to a second session only after the commit, auto mode tracks an explicit `BEGIN`, switching to auto while open rejects `statementFailed` and stays open, commit and rollback with nothing open are no-ops                                                                                                                                                                                                                                                                                                                                                     |
| `cancel`           | `Session.cancel` stops the running statement from another call                                                                                                                                                                                                                  | idle cancel is a no-op, a sleeping statement rejects `cancelled` well before it ends, the session runs the next statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `schemaTree`       | `Session.introspector` lists namespaces, describes one, quotes a qualified name                                                                                                                                                                                                 | the current namespace is marked, the fixture's tables and `customer_totals` view are described, `orders` has its foreign key and `orders_placed_at_idx`, `customers` has its primary and unique keys, an unknown namespace rejects `introspectionFailed`, `qualifiedName` quotes an awkward identifier, the session runs statements after introspecting                                                                                                                                                                                                                                                                                                       |
| `ddl`              | `Introspector.definition` reads a relation's definition; requires `schemaTree`                                                                                                                                                                                                  | `definition` exists exactly when `ddl` is declared; `orders` has its columns, primary key, `orders_total_nonnegative` check and the foreign key naming `customers`; `customer_totals` has its query; `customers` carries its comment where the dialect has one; an unknown relation rejects `definitionNotFound` naming the path and relation                                                                                                                                                                                                                                                                                                                 |
| `explain`          | `Session.explain` returns a plan without running the statement; `SqlLanguage.explainable` checks first; requires `sql`                                                                                                                                                          | `explainable` and `explain` exist exactly when `explain` is declared; a join explains to a tree with an operation; explaining `DELETE FROM orders` leaves its three rows; DDL, two statements and an `EXPLAIN …` are refused with a reason and `explain` rejects `explainUnsupported`; only a write `writes`; without `explainAnalyze`, Analyse is refused                                                                                                                                                                                                                                                                                                    |
| `explainAnalyze`   | `Session.explain(sql, { analyze: true })` runs the statement and returns actual rows and times; requires `explain`                                                                                                                                                              | a read analyses with actual rows on its nodes; where the dialect analyses a write and has `transactions`, an `UPDATE` analysed in manual mode then rolled back leaves `orders` unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `keepAlive`        | `connect` honours `keepAliveInitialDelayMs`; `Session.ping` answers while idle and rejects `connectionLost` once the connection is gone (decision 054)                                                                                                                          | `ping` exists exactly when declared; a session connected with a delay pings and runs statements; a closed session's ping rejects `connectionLost`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `currentNamespace` | `Session.currentNamespace` reads the database or schema the session is in; `SqlLanguage.classify` marks `setsNamespace`; requires `sql`                                                                                                                                         | `currentNamespace` exists exactly when declared; a fresh session reads the fixture's namespace; the fixture's switch statement is classified `setsNamespace` and moves the read to its target; a switch to a missing target rejects and leaves it                                                                                                                                                                                                                                                                                                                                                                                                             |
| `bulkInsert`       | `Session.insertRows` writes a batch of text rows atomically; `language` has `importType` and `createTable`; requires `transactions`                                                                                                                                             | `insertRows`, `importType` and `createTable` exist exactly when `bulkInsert` is declared; each `type_probe` row written as the exporter's text into `type_probe_copy` reads back equal; a batch the database refuses leaves none of its rows and the transaction usable; control characters and quotes round-trip; a table created with every import type takes that type's sample text                                                                                                                                                                                                                                                                       |
| `serverMessages`   | `ExecuteResult.messages` and `ExplainedPlan.messages` carry the server's warnings and notices once the result is complete (decision 066); requires `sql`                                                                                                                        | the fixture's `statements.message` returns its level and code; a quiet statement has none; the next statement's messages are its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sessions`         | `Session.sessions` lists the server's sessions and cancels or terminates one; `Session.serverSessionId` is the connection's own id (decision 088); requires `sql` or `commands`, and `schemaTree` or `keyValue`                                                                 | both exist exactly when declared; a session lists itself by its `serverSessionId`; a second session's sleep lists `active` with its text; Cancel stops it early and leaves it usable; Terminate removes a session from the list; terminating a closed one rejects `statementFailed`; a write waiting on another session's lock lists `blocked` with that session in `blockedBy`; the fixture's `limited` account lists only its own and a note naming the grant                                                                                                                                                                                               |
| `commands`         | `Session.execute` runs one command of a non-SQL language; the plugin exports `commandLanguage` (`split`, `classify`, `complete`, optional `signatureAt` and `inspect`); a scalar answer comes back as `ExecuteResult.reply`; excludes `sql` (decision 112)                      | `commandLanguage` exists exactly when declared; the fixture's scripts split one span per line, skipping comments; a scalar command replies with no columns; an array reads `#`, `value`; a map `key`, `value`; a binary value comes back as whole bytes; a read-only session refuses the fixture's write naming the command; the fixture's flush is destructive and `confirmByName`; its costly command is marked and its quick fix rewrites it; completion never rejects, with or without a session                                                                                                                                                          |
| `keyValue`         | `Session.keyspace` lists databases, scans and describes keys, reads one into rows, previews and applies guarded changes, renames, expires and removes keys (decision 113, 115); a command that reads one key reports `ExecuteResult.source` (decision 119); requires `commands` | `keyspace` exists exactly when declared; the fixture database is listed and one is current; a scan to the end returns every fixture key once in more than one batch; `MATCH` and type filter; describe answers type and expiry in order, a missing key with no type; a binary key name round-trips through scan and read; a hash reads `field`, `value`; a zset `#`, `member`, `score` in rank order; a stream `id` and its fields; a change applies with the commands preview listed; a guarded apply over a changed element rejects `conflict` and writes nothing; unguarded it writes; each fixture command reports its `source` and `read` (decision 119) |
| `nodes`            | `Session.nodes()` lists the servers; `ExecuteOptions.node` runs a command on one, on every primary or by key (decision 114); requires `sql` or `commands`                                                                                                                       | `nodes` exists exactly when declared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `serverInfo`       | `Session.serverInfo(node)` answers titled sections of figures and `Session.slowLog(node, limit)` the slowest commands (decision 114); requires `sql` or `commands`                                                                                                              | both exist exactly when declared; every node and the null node answer titled sections with entries; the slow log holds at most the limit, newest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `routineCall`      | `language.routineCall(routine, qualifiedName, args)` writes the console text that calls a described routine, every value a named `:marker` in `params` (decision 090); requires `sql` and `schemaTree`                                                                          | `routineCall` exists exactly when declared; the fixture's routines describe with their parameters, modes, defaults and result; a function call returns its result; a NULL argument binds as NULL; a procedure's OUT values come back as the last statement's row; a skipped default takes it; DEFAULT on a parameter without one throws `statementFailed`                                                                                                                                                                                                                                                                                                     |

Every plugin, whatever it declares, is checked for a valid schema; for its manifest's connection
fields agreeing with `connectionSchema` (each field a key the schema accepts, every required key
filled by a field, a `password` field marked `secret`) and its URL agreeing with the fields (each
part and parameter filling a declared field, only the password part a secret one, the port a
number field, mapped values among the field's options); for a non-empty `serverVersion`; for a
`tls` that is absent, `null` or a non-empty protocol and cipher; when the
fixture gives a `wrongPasswordConfig`, for `connect` rejecting `connectionFailed`; and, when it
gives `statements.write`, for a read-only session rejecting that write with `statementFailed` and
staying usable.

`runPluginContract(plugin, fixture)` from `@table-craft/plugin-api/testing` registers the cases for
each declared capability (decision 013). The fixture carries what the suite cannot write portably:

| Field                 | Meaning                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`            | The plugin's parsed `table-craft-plugin.json`                                                                                                                                                                                                                       |
| `config`              | A config for a database seeded from `test/db/schema/<dialect>.sql`                                                                                                                                                                                                  |
| `wrongPasswordConfig` | Optional; the same database with a password it refuses                                                                                                                                                                                                              |
| `statements.sleep(s)` | Optional; a statement that sleeps `s` seconds, required to exercise `cancel`                                                                                                                                                                                        |
| `statements.write`    | Optional; an idempotent write (`TYPE_PROBE_WRITE`) for the read-only case                                                                                                                                                                                           |
| `sessions`            | Required with `sessions`: `monitorConfig`, an account that sees and may stop every session, and optional `limited { config, note }`, one that sees only its own and the pattern its listing's note matches                                                          |
| `statements.message`  | Required with `serverMessages`; a statement the server answers with one message, and its `level` and `code`                                                                                                                                                         |
| `typeProbe.expected`  | Required with `sql`; the `type_probe` rows as wire values; every dialect shares `test/support/typeProbe.ts`                                                                                                                                                         |
| `catalog`             | Required with `schemaTree`: the fixture's namespace path, an awkward identifier with its expected quoting (`quoted { name, qualified }`), the name of `orders`' check (`ordersCheck`) and `customers`' expected comment (`customersComment`, null without comments) |
| `scripts`             | Optional; dialect scripts with the statements `split` must return (`SplitCase { text, statements }`), added to the shared ones                                                                                                                                      |
| `sql`                 | Optional `ContractSql`: the one-row select, the large result, the explain join, the shared scripts, drop-if-exists, the temporary table and `BEGIN` in the dialect's words; each defaults to today's text (decision 100)                                            |
| `commands`            | Required with `commands`: scripts and their spans, a scalar, an array and a map command with their answers, a binary value's command and hex, a write and its name, a costly command and its fixed text, and a command that confirms by name                        |
| `keyspace`            | Required with `keyValue`: the database, a scan pattern with its count and batch, a typed match, an expiring key, a binary key name, hash, zset and stream keys with their rows, and the edit the apply cases make                                                   |
| `sessions.sleepQuery` | Optional; what the listing shows for the sleeping statement when it is not its text (Redis lists `blpop`)                                                                                                                                                           |
| `foldName`            | Optional; folds the fixture names the suite compares (Oracle's upper case); `"Line Items"` is never folded                                                                                                                                                          |

### DatasourcePlugin and Session

```ts
interface DatasourcePlugin {
  readonly id: string;
  readonly capabilities: readonly Capability[];
  readonly connectionSchema: z.ZodType; // core parses the config with it before connect
  readonly language?: SqlLanguage; // present exactly when `sql` is declared
  connect(config: unknown, options: ConnectOptions): Promise<Session>;
}

interface SqlLanguage {
  split(text: string): readonly StatementSpan[]; // { from, to, sql }, UTF-16 offsets, empties dropped
  classify(sql: string): StatementClass; // { kind, destructive: reason | null, setsNamespace? }
  quoteIdentifier(name: string): string; // "x" or `x`, the quote doubled inside
  literal(value: WireValue, columnType: string | null): string; // reads back as the same value
  emptyInsert(qualifiedTable: string): string; // a row of defaults: DEFAULT VALUES or () VALUES ()
  updateDefault(defaultExpression: string | null): string; // SET col = <this>: DEFAULT, or SQLite's expression
  generate(statement: GeneratedStatement, relation: Relation, qualifiedName: string): string; // sqlGenerator
  explainable?(sql: string, options: ExplainOptions): Explainability; // present exactly when `explain` is declared
  format(text: string, options: FormatOptions): string; // { style, keywordCase, indentWidth, linesBetweenStatements, alignAliases }; throws when it cannot
  parameters(statement: string): readonly SqlParameter[]; // { name, from, to, style }, outside literals and comments
  bind(statement: string, values: Readonly<Record<string, ParameterValue>>): BoundStatement; // { sql, params }
  importType?(column: InferredColumn): string; // { kind, integerDigits, scale } to a column type; with `bulkInsert`
  createTable?(qualifiedName: string, columns: readonly NewColumn[]): string; // CREATE TABLE for an import; with `bulkInsert`
  signatureAt?(request: CompletionRequest, catalog: CompletionCatalog): Promise<SignatureHelp | null>; // the call at the caret; sqlCompleter (decision 098)
  selectSource?(sql: string, catalog: CompletionCatalog): Promise<SelectSource>; // the one table a plain SELECT reads; sqlCompleter
  savepoint?(name: string): SavepointStatements; // { set, rollback, release }; sqlSavepoints
}

type SelectSource =
  | { kind: "table"; path: readonly string[]; relation: string; columns: readonly (string | null)[] } // null: an expression
  | { kind: "readOnly"; reason: string }; // "the result joins two or more tables"

interface ExplainOptions {
  readonly analyze: boolean;
}

type Explainability = { ok: true; writes: boolean } | { ok: false; reason: string };

type GeneratedStatement = "drop" | "select" | "insert" | "update";

interface ConnectOptions {
  readonly readOnly: boolean; // a guard against mistakes, not a security boundary (decision 011)
  readonly keepAliveInitialDelayMs?: number; // TCP keepalive; the engine asks on every connection (decision 054)
  readonly serverName?: string; // the host a certificate must name when config's host is a tunnel's 127.0.0.1 (decision 073)
}

interface ExecuteOptions {
  readonly fullBytes?: boolean; // BytesValue.preview carries every byte; an export asks (decision 040)
}

interface Session {
  readonly serverVersion: string | null; // "17.4", "8.4.3", "3.53.4"
  execute(sql: string, params?: readonly ParameterValue[], options?: ExecuteOptions): Promise<ExecuteResult>; // one at a time; params bind the driver's placeholders; rejects with a PluginError
  readonly privateDatabase?: boolean; // another session on the same config sees another database (SQLite :memory:)
  readonly tls?: TlsInfo | null; // { protocol, cipher } of an encrypted connection, null when unencrypted, absent when not reported (decision 072)
  cancel?(): Promise<void>; // present exactly when `cancel` is declared; no-op when idle; may drop the connection where nothing else stops the statement safely (decision 058)
  readonly introspector?: Introspector; // present exactly when `schemaTree` is declared
  readonly transactions?: Transactions; // present exactly when `transactions` is declared
  explain?(sql: string, options: ExplainOptions): Promise<ExplainedPlan>; // present exactly when `explain` is declared
  currentNamespace?(): Promise<readonly string[] | null>; // present exactly when `currentNamespace` is declared; never opens a transaction
  ping?(): Promise<void>; // present exactly when `keepAlive` is declared; the host calls it only while idle and bounds the wait
  insertRows?(target: InsertTarget, rows: readonly InsertRow[]): Promise<void>; // present exactly when `bulkInsert` is declared; all rows or none
  close(): Promise<void>; // settles in bounded time even on a dead network
}

interface Transactions {
  setMode(mode: "auto" | "manual"): Promise<void>; // to auto rejects `statementFailed` while open
  commit(): Promise<void>; // no-op when nothing is open
  rollback(): Promise<void>;
  readonly mode: "auto" | "manual";
  readonly open: boolean;
}

interface Introspector {
  namespaces(): Promise<readonly Namespace[]>; // sorted by name
  describe(path: readonly string[]): Promise<NamespaceCatalog>; // rejects `introspectionFailed`
  qualifiedName(path: readonly string[], name: string): string; // quoted as the dialect quotes
  definition?(path: readonly string[], name: string): Promise<string>; // present exactly when `ddl` is declared
}

class PluginError extends Error {
  readonly code:
    | "cancelled"
    | "connectionFailed"
    | "statementFailed"
    | "introspectionFailed"
    | "definitionNotFound"
    | "explainUnsupported"
    | "connectionLost" // the connection was gone before the statement was sent
    | "sessionBusy"; // an earlier result still holds the session; the host drops it (decision 058)
}

class DefinitionNotFoundError extends PluginError {
  readonly path: readonly string[];
  readonly relation: string;
}

interface ExecuteResult {
  readonly columns: readonly Column[]; // empty for a statement without rows
  readonly rows: AsyncIterable<Row>; // pulled until the fetch cap, then returned
  readonly rowsAffected: number | null;
}

interface Column {
  readonly name: string;
  readonly type: string | null; // the database's declared type, when it has one
  readonly origin?: ColumnOrigin | null; // the base column it reads; null for an expression, absent when the driver cannot tell
  readonly typeClass?: TypeClass; // the plugin's own class, ahead of the name table (decision 101)
}

interface ColumnOrigin {
  readonly table: string; // the driver's id: PostgreSQL's table OID, MySQL's and SQLite's db.table
  readonly column: string;
}
```

`connect` rejects with `connectionFailed`; `execute` rejects with `statementFailed`, or with
`cancelled` when `cancel` stopped it, or with `connectionLost` when the driver already knew the
connection was gone, so the host can reconnect and run it without running it twice. Each bundled plugin carries its own copy of the plugin API,
so the host recognises a `PluginError` with `isPluginError` (by name and code), not `instanceof`.
`cancel` reaches the database on a short-lived second connection (`pg_cancel_backend`,
`KILL QUERY`, `KILL TIDB QUERY` on TiDB 6.1 and later); on TiDB before 6.1, where no kill is safe,
it drops the connection and `execute` rejects `cancelled` saying the session was reset (decision
058). Returning the rows iterator early closes the cursor or stream and leaves the session usable;
the MySQL plugin reads an abandoned result to the end where it cannot kill it, and drops the
connection if that takes longer than 10 s. `execute` on a session an earlier result still holds
rejects `sessionBusy`, which the host treats as its own bug. A read-only session is set up by the plugin as it connects: PostgreSQL
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, MySQL `SET SESSION TRANSACTION READ ONLY`,
SQLite `PRAGMA query_only = ON`.

`insertRows(target, rows)` (contract 0.15.0, decision 046) takes `target { table, columns }`, the
table already quoted and each column with its declared type, and rows of text or `NULL` in the
exporter's spelling: bytes as `0x<hex>`, booleans `true` or `false`. One call is all or nothing:
inside a transaction the plugin wraps it in a savepoint, so a refused batch rejects
`statementFailed` and the transaction stays usable; a lost link rejects `connectionFailed`.
PostgreSQL sends one `COPY … FROM STDIN` per call (`pg-copy-streams`, decision 047), MySQL one
multi-row `INSERT` whose values the driver escapes, SQLite a prepared multi-row `INSERT`; no value
is ever spliced into SQL text.

### SQL language and transactions

`@table-craft/plugin-api/sql` offers the tokenizer the built-ins share (decision 023):
`sqlSplitter(options)`, `classifyTokens(sql, options)` and `transactionEffect(sql, options)`, which
answers `begin`, `end` or `null`, and for the copy extractor `quoteIdentifierWith(quote)` and
`sqlLiteral(value, options)`. Each built-in passes its dialect options:

| Plugin     | Options                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | dollar quotes, nested block comments, `BEGIN … END` bodies; `"x"`, `'\x…'::bytea`                                |
| MySQL      | backslash escapes, `DELIMITER`, `#` comments, `BEGIN … END` bodies; `` `x` ``, `X'…'`, backslash-escaped strings |
| SQLite     | `BEGIN … END` bodies; `"x"`, `X'…'`                                                                              |

For Oracle and SQL Server plugins the kit also offers, each off by default (decision 100):
`bracketIdentifiers` (`[a]]b]`, and `quoteIdentifierWith('[')`), `qQuotes` (Oracle `q'[…]'`),
`nationalStrings` (`N'…'`, and `sqlLiteral`'s `nationalText`) and `batchSeparator`, `go` or
`slash`. A separator is a whole line outside quotes and comments: `GO`, optionally `GO <n>`
(`repeat: n` on the span it ends), or `/` alone; it belongs to no statement. Under a separator, a
routine definition (and under `slash` an anonymous `DECLARE`/`BEGIN` block) runs to the next
separator line, keeping its own `;`.

A span runs from the statement's first token to its last, so comments around it stay out. A
`BEGIN … END` body opens only inside `CREATE TRIGGER`, `FUNCTION`, `PROCEDURE` or `EVENT`, so
`BEGIN;` still starts a transaction. `classify` reads the first keyword (through a `WITH`) into
`read`, `write`, `ddl`, `transaction` or `other`, and names a destructive statement's reason:
`UPDATE without WHERE`, `DELETE without WHERE`, `DELETE without WHERE (LIMIT does not choose the
rows)`, `DROP TABLE` (or whatever is dropped) and `TRUNCATE`. Only a top-level `WHERE` counts.
`EXPLAIN`, `DESCRIBE` or `DESC` before a statement is `read` and never destructive, unless it
analyses (`ANALYZE`/`ANALYSE` bare or among the parenthesised options, not `FALSE`/`OFF`): then the
kind and reason are the inner statement's, the reason prefixed `EXPLAIN ANALYZE runs it: `, so Run
asks before `EXPLAIN ANALYZE DELETE FROM orders` (decision 031).

In manual mode the plugin opens a transaction before the first statement that is not itself a
transaction statement: `BEGIN` on PostgreSQL and SQLite, `SET autocommit = 0` on MySQL. In either
mode `transactionEffect` tracks an explicit `BEGIN`, `START TRANSACTION`, `COMMIT` or `ROLLBACK`,
and on MySQL a DDL statement's implicit commit closes the transaction. Closing a session with a
transaction open rolls it back.

`sqlFormatter(options)` gives `format`, bundled into each plugin. It formats statement by statement
as the plugin's dialect, cases keywords as `keywordCase` says (`upper`, `lower`, `preserve`), indents
by `indentWidth` (1–8) and puts `linesBetweenStatements` (0–5) blank lines between statements. A
multi-line block comment is kept byte for byte; a MySQL script with `DELIMITER` is refused rather
than reflowed, and so is a script holding a `GO` or `/` separator line. The dialects are
`postgresql`, `mysql`, `sqlite`, `plsql` and `transactsql`. `style` picks the layout. `aligned` (decision 061, `sql/layout.ts`) parses the
dialect lexer's tokens: the first item on the clause keyword's line, the rest lined up under it,
`AS` in a select list in one column when `alignAliases` is on, `AND`/`OR` right-aligned to the end
of `WHERE`/`HAVING`/`ON`, calls and lists kept whole, subqueries at the column after `(`. It covers
`SELECT`, set operators, `WITH`, `INSERT`, `UPDATE`, `DELETE` and `EXPLAIN` before them; any other
statement, or one whose tokens the layout would change, gets the `standard` layout (decision 062),
which is `sql-formatter` (decision 042).

`sqlParameters(options)` gives `parameters` and `bind` over the same tokenizer (decision 043), so a
marker inside a string, a quoted identifier, a comment, a dollar quote or a `::cast` is never one:

| Plugin     | Styles        | Native placeholder | `bind` turns `:id … :id` into |
| ---------- | ------------- | ------------------ | ----------------------------- |
| PostgreSQL | `:name`, `$1` | `$1`               | `$1 … $1`, one value          |
| MySQL      | `:name`, `?`  | `?`                | `? … ?`, the value twice      |
| SQLite     | `:name`, `?`  | `?`                | `? … ?`, the value twice      |

Two more native forms serve Oracle and SQL Server (decision 100): `colonNumbered` binds `:1, :2,
:3`, one value per occurrence, and `atNumbered` binds `@p1`, one value per name.

A `?` is named `?1`, `?2`… by position within its statement. `bind` rejects `statementFailed` when
a value is missing. Values are text or `null`; the database converts text as it would a literal.

`sqlStatementStream(options)` gives the optional `splitStream()` (plan 041, decision 081): a
`StatementStream` whose `push(text)` takes the script a piece at a time and answers the statements
complete so far, and whose `end()` answers the rest. Each `StreamedStatement` is a span with
offsets from the start of everything pushed plus its 1-based `line` and `column`; the statements
equal `split` on the whole text, for any cut of the pieces (the contract suite checks a cut at
every code point). It rescans only whole lines and only once the unfinished tail has doubled, so a
huge statement costs linear time. A plugin without it gets its scripts split whole, up to 32 MiB.

### Catalog

The namespace is the unit of introspection (decision 022). A `Namespace` is
`{ path, name, kind: "database" | "schema", system, current }`:

| Plugin     | Namespaces                                                       | `qualifiedName(path, "orders")` |
| ---------- | ---------------------------------------------------------------- | ------------------------------- |
| PostgreSQL | the connected database `[db]`, then its schemas `[db, schema]`   | `"public"."orders"`             |
| MySQL      | each database as `[db]`, kind `schema`                           | `` `table_craft`.`orders` ``    |
| SQLite     | `main`, `temp` and attached databases as `[name]`, kind `schema` | `"main"."orders"`               |

System namespaces are `pg_catalog`, `information_schema` and `pg_toast`; `information_schema`,
`mysql`, `performance_schema` and `sys`; and SQLite's `temp`. `describe(path)` answers a
`NamespaceCatalog { path, relations, routines, sequences }`. A `Relation` is a table, view or
materialized view with its comment, `columns` (`name`, `position`, `type` as the database writes
it, `nullable`, `default` as database text, `comment`, `autoIncrement`), `primaryKey`,
`uniqueKeys`, `foreignKeys` (`target { path, relation, columns }`, `onDelete`, `onUpdate`) and
`indexes` (`unique`, `primary`). A `Routine` is a function or procedure with its `signature` (the
argument list as the database prints it; name, kind and signature are unique in a namespace, so
each PostgreSQL overload is its own routine, and MySQL lists a function and a procedure of one
name both), `parameters` in declaration order (`name` or null, `type`, `mode` `in`, `out`, `inout`
or `variadic`, `hasDefault`) and `returns`, a function's result as the database prints it
(`numeric`, `TABLE(id integer, total numeric)`), null for a procedure (decision 090). Lists are
sorted by name, columns by position. Triggers, checks,
partitions, users and grants are not described; a relation's definition shows them (DDL and SQL
generation). PostgreSQL describes a schema the user lacks
`USAGE` on as `introspectionFailed` ("permission denied for schema …"), since `pg_catalog` itself
would answer. SQLite has no constraint names, so the plugin names keys as DataGrip does
(`orders_pk`, `orders_customers_id_fk`).

### Wire values

A cell is a `WireValue`: what crosses a MessagePort without loss or surprise (decision 009).

| Value                            | Shape                                                               |
| -------------------------------- | ------------------------------------------------------------------- |
| SQL `NULL`                       | `null`                                                              |
| boolean, safe-range number, text | the JSON primitive                                                  |
| integer outside the safe range   | `{ kind: "bigint", value: "<decimal>" }`                            |
| binary                           | `{ kind: "bytes", preview: "<hex of the first 32 bytes>", length }` |
| JSON document                    | `{ kind: "json", text }`                                            |
| date or timestamp                | `{ kind: "date", iso }`                                             |

`toWireValue` converts the JavaScript values drivers return. Which shape a database type takes is
fixed by decision 017, so the same row reads the same on every database:

| Database type                                                   | Crosses as                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `date`, `time`, `timestamp`, `timestamptz`, `DATETIME`          | the database's own text; no `Date`, so no time-zone shift   |
| `numeric`, `DECIMAL`                                            | the database's text                                         |
| 64-bit integer                                                  | a number when safe, else the `bigint` tag (`toWireInteger`) |
| `boolean`, MySQL `TINYINT(1)`, SQLite column declared `BOOLEAN` | `true` / `false`                                            |
| `json`, `jsonb`, MySQL `JSON`, SQLite column declared `JSON`    | the `json` tag with the database's text                     |
| `bytea`, `BLOB`, `BINARY`, `VARBINARY`                          | the `bytes` tag                                             |

The `date` tag stays for plugins whose driver only hands back a `Date`.

Each column also has a type class (`TypeClass` in plugin-api: `integer`, `float`, `decimal`,
`boolean`, `temporal`, `json`, `bytes`, `text`) for display, alignment, local sort and export. A
plugin may name it in `Column.typeClass`, as SQL Server must for `bit`; otherwise core reads it
from the type name, which knows the PostgreSQL, MySQL, SQLite, Oracle and SQL Server names that
mean one thing everywhere (decision 101).

## Protocol

Every message is typed in `packages/desktop/src/engine/protocol.ts`, the only module engine and
renderer share. The renderer may not import core or plugin-api, so the wire types and the
constants both sides need are restated there and pinned by `test/desktop/protocol.test.ts`.

### Main to engine (parent port)

| Message                  | Payload                                                                                                             | When                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `engine.boot`            | `mode` (`serve` or `probe`), `datasource { id, pluginId, config, readOnly, keepAliveSeconds, ssh? }`, `pluginRoots` | Once, right after fork                   |
| `engine.port`            | transfers one `MessagePortMain`                                                                                     | Each time a window connects (serve only) |
| `engine.host-key-answer` | `requestId`, `verdict` (`trusted`, `rejected`, or `changed` with `knownFingerprint` and `file`)                     | The answer to an `engine.host-key`       |
| `engine.shutdown`        | none                                                                                                                | Disconnect or delete (decision 021)      |

`config` carries the datasource's secrets, decrypted by main for this engine alone (decision 020).
`ssh`, present only when the tunnel is on, is `{ host, port, user, auth, keyPath?, password?,
passphrase? }` with its secrets decrypted the same way. Before signing in to a bastion either
engine posts `engine.host-key { requestId, offer { host, port, algorithm, fingerprint, key } }` and
waits for the answer (decision 071).
A `probe` engine connects once, answers `engine.probed { result }` with
`{ ok: true, pluginName, serverVersion, elapsedMs, ssh?, tls? }` or `{ ok: false, error, ssh? }`,
where `ssh { host, user, elapsedMs }` is the SSH hop when it was reached and `tls` is the session's
`{ protocol, cipher }` or `null` when the plugin reports it, and exits; main
kills it after `PROBE_TIMEOUT_MS = 15_000`, a clock that stops while a host key is being asked
about, and answers `timedOut`. A `serve` engine lives while any
port to it is open and exits when the last one closes; on `engine.shutdown` it closes its sessions
and exits, and main kills it after `SHUTDOWN_GRACE_MS = 3_000`. Main never sees a request.

### Renderer to engine (MessagePort)

A request is `{ id, type, ...params }`; the engine answers `{ id, type, result }` with the same
`id` and `type`, or `engine.error`. Requests are parsed before routing. Sessions and result
handles belong to the port that created them and are released when it closes.

| Request                 | Params                                                                                            | Result                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.open`          | none                                                                                              | `{ sessionId, pluginName, capabilities, serverVersion, namespace }`; `namespace` needs `currentNamespace`                                        |
| `script.split`          | `text`                                                                                            | `ClassifiedStatement[]`: `{ from, to, sql, kind, destructive, parameters }`                                                                      |
| `sql.format`            | `text`, `options: FormatOptions`                                                                  | the formatted text, or `formatFailed`                                                                                                            |
| `statement.execute`     | `sessionId`, `sql`, `parameters?`, `pageRows`, `fetchAllCap`, `timeoutSeconds?`, `node?`          | `{ handle, columns, typeClasses, rowCount, complete, cursorOpen, rowsAffected, firstWindow, transactionOpen, namespace?, reconnected?, reply? }` |
| `sql.explainable`       | `sql`, `analyze`                                                                                  | `Explainability`: `{ ok: true, writes }` or `{ ok: false, reason }`; no session; needs `explain`                                                 |
| `statement.explain`     | `sessionId`, `sql`, `analyze`, `timeoutSeconds?`                                                  | `{ plan: ExplainedPlan, transactionOpen, reconnected? }`; needs `explain`, or `explainAnalyze` to analyse; see Explain                           |
| `transaction.setMode`   | `sessionId`, `mode`                                                                               | `{ mode, transactionOpen, namespace? }`                                                                                                          |
| `transaction.commit`    | `sessionId`                                                                                       | `{ mode, transactionOpen, namespace? }`; a no-op when nothing is open                                                                            |
| `transaction.rollback`  | `sessionId`                                                                                       | `{ mode, transactionOpen, namespace? }`; a no-op when nothing is open                                                                            |
| `statement.cancel`      | `sessionId`                                                                                       | `null`; stops the running statement, a no-op when idle                                                                                           |
| `result.window`         | `handle`, `offset`, `limit`                                                                       | `{ offset, rows, matches? }`, at most `RESULT_WINDOW_ROWS` shown rows; `matches` are `[row, column]` pairs                                       |
| `result.release`        | `handle`                                                                                          | `null`; releasing twice is not an error                                                                                                          |
| `result.fetchMore`      | `handle`, `all`, `pageRows`, `fetchAllCap`                                                        | `ResultState { rowCount, complete, cursorOpen }`; one page, or up to `fetchAllCap`                                                               |
| `result.stopFetch`      | `handle`                                                                                          | `ResultState`; stops a running fetch, the cursor stays open                                                                                      |
| `result.sort`           | `handle`, `keys: { column, direction }[]`                                                         | `ResultState`; windows read through the new order, `[]` restores it                                                                              |
| `result.extract`        | `handle`, `extractor`, `rows: { from, to }[]`, `columns`                                          | the text, rows in sorted order; with a local filter, `rows` count shown rows                                                                     |
| `result.aggregate`      | `handle`, `rows: { from, to }[]`, `columns`                                                       | `SelectionAggregates { cells, distinct, kind, sum, avg, min, max }` over the shown rows; see Result grid                                         |
| `result.cellBytes`      | `handle`, `row`, `column`, `maxBytes`                                                             | the cell's whole `bytes` value, re-read by key when the grid holds a preview; refused past `maxBytes`                                            |
| `result.saveBytes`      | `handle`, `row`, `column`, `path`, `maxBytes`                                                     | the bytes written; the engine writes the whole value to the absolute `path`                                                                      |
| `result.loadBytes`      | `handle`, `path`, `maxBytes`                                                                      | `StagedBytes { id, length, preview }`; the file stays in the engine for the result's edits until it is released                                  |
| `result.view`           | `handle`, `spec: ViewSpec \| null`                                                                | `ViewState { shown, filtered, sources, matches, error }`; sets find and local filter (decision 050), `null` drops them                           |
| `result.viewState`      | `handle`                                                                                          | `ViewState` after a fetch or sort recomputed the view                                                                                            |
| `result.findMatch`      | `handle`, `from: { row, column } \| null`, `backward`                                             | `{ index, row, column }` of the next match after `from`, wrapping, or `null`                                                                     |
| `export.start`          | `source`, `format`, `path`, `stallSeconds`                                                        | `ExportTask`; starts a background export (decision 040); `path` must be absolute                                                                 |
| `export.cancel`         | `taskId`                                                                                          | `null`; the task ends `cancelled` and its `.part` file is removed                                                                                |
| `export.retry`          | `taskId`, `stallSeconds`                                                                          | a new `ExportTask` from row 0; only a re-run or table export is retryable                                                                        |
| `export.list`           | none                                                                                              | `ExportTask[]`, every task of the engine                                                                                                         |
| `import.preview`        | `file`, `format`                                                                                  | `ImportPreview { names, rows, kinds, types, encoding, ragged, size }`, the first 100 rows; see Import                                            |
| `import.ddl`            | `path`, `relation`, `columns: { name, type, field }[]`                                            | the `CREATE TABLE` a new-table import would run                                                                                                  |
| `import.start`          | `file`, `format`, `target`, `transaction`, `errors`, `stallSeconds`                               | `ImportTask`; starts a background import (decision 046); `file` must be absolute                                                                 |
| `import.cancel`         | `taskId`                                                                                          | `null`; the task rolls back what it has not committed and ends `cancelled`                                                                       |
| `import.resume`         | `taskId`, `stallSeconds`                                                                          | a new `ImportTask` from the first uncommitted row, or from row 1 when nothing was committed                                                      |
| `import.list`           | none                                                                                              | `ImportTask[]`, every import of the engine                                                                                                       |
| `script.run`            | `files`, `namespace`, `onError`                                                                   | `ScriptTask`; runs absolute `.sql` paths in order on a session of its own, after switching to `namespace` when not null (decision 081)           |
| `script.answer`         | `taskId`, `answer`                                                                                | `null`; answers a task's `question` with `skip`, `skipAll`, `stop` or `retry` (decision 083)                                                     |
| `script.cancel`         | `taskId`                                                                                          | `null`; cancels the running statement and ends the task `cancelled`                                                                              |
| `script.list`           | none                                                                                              | `ScriptTask[]`, every script run of the engine                                                                                                   |
| `session.close`         | `sessionId`                                                                                       | `null`; releases the session's handles, then closes it                                                                                           |
| `catalog.namespaces`    | `refresh?`                                                                                        | `Namespace[]`                                                                                                                                    |
| `catalog.describe`      | `path`, `refresh?`                                                                                | `{ catalog, introspectedAt, elapsedMs }`                                                                                                         |
| `catalog.qualifiedName` | `path`, `name`                                                                                    | the plugin's quoting, e.g. `"public"."orders"`                                                                                                   |
| `catalog.definition`    | `path`, `name`                                                                                    | the relation's DDL text, read anew each time; needs `ddl`; see DDL and SQL generation                                                            |
| `sql.generate`          | `path`, `name`, `statement`                                                                       | `create`, `drop`, `select`, `insert` or `update` text for the relation; `create` is `catalog.definition`                                         |
| `routine.call`          | `path`, `name`, `kind`, `signature`, `args`                                                       | `{ sql, params }`: the plugin's console text calling the cached routine and each marker's value; needs `routineCall`; see Execute a routine      |
| `table.query`           | `sessionId`, `path`, `relation`, `where`, `orderBy`, `pageRows`, `fetchAllCap`, `timeoutSeconds?` | `TableQuery { statement, sql, editable, columns, foreignKeys, referencing }`; see Table data editor                                              |
| `table.count`           | `path`, `relation`, `where`                                                                       | the row count, read on a short-lived session of its own                                                                                          |
| `table.orderBy`         | `terms: { name, direction }[]`                                                                    | the ORDER BY text in the plugin's quoting, e.g. `"qty" DESC, "label"`                                                                            |
| `table.condition`       | `handle`, `rows`, `columns: { column, name }[]`                                                   | a WHERE condition matching those rows' values, written against `name`                                                                            |
| `completion.complete`   | `text`, `offset`, `scope?: { path, relation }`, `current?`                                        | `{ from, to, items, validFor }`; see Completion and navigation                                                                                   |
| `completion.signature`  | `text`, `offset`, `scope?: { path, relation }`                                                    | `{ name, summary, signatures, argument, from, to }` or `null`; see Completion and navigation                                                     |
| `navigation.resolve`    | `text`, `offset`, `current?`                                                                      | `Declaration` or `null`; see Completion and navigation                                                                                           |
| `edits.preview`         | `handle`, `edits: RowEdit[]`                                                                      | the statements Submit would run                                                                                                                  |
| `edits.submit`          | `sessionId`, `handle`, `edits: RowEdit[]`                                                         | `{ statements, rowsAffected, transactionOpen }`, or `editRejected` after a rollback                                                              |
| `result.editable`       | `handle`, `current?`                                                                              | `ResultEditable { editable, columns, readOnlyColumns, key? }`; see Editing a console result                                                      |
| `server.nodes`          | none                                                                                              | `ServerNode[]`, primaries first; needs `nodes`; see Command consoles                                                                             |
| `server.info`           | `node` (null for the server)                                                                      | `ServerInfo { node, sections }`; needs `serverInfo`; see Server tab                                                                              |
| `server.slowLog`        | `node`, `limit`                                                                                   | `SlowCommand[]`, newest first; needs `serverInfo`                                                                                                |
| `keyspace.databases`    | none                                                                                              | `{ delimiter, databases }`; needs `keyValue`; see Key browser                                                                                    |
| `keyspace.scan`         | `database`, `cursor`, `match`, `keyType`                                                          | `KeyScan { keys, cursor, scanned }`; a null cursor means the scan is done                                                                        |
| `keyspace.describe`     | `database`, `keys`                                                                                | `KeyInfo[]` in order: type and expiry, a missing key with a null type                                                                            |
| `keyspace.open`         | `sessionId`, `database`, `key`, `range`, `pageRows`, `fetchAllCap`, `timeoutSeconds?`             | `OpenedKey { details, statement, value, readOnly }`: rows held like a statement's                                                                |
| `keyspace.preview`      | `key`, `changes`, `options`                                                                       | the commands `keyspace.apply` would run                                                                                                          |
| `keyspace.apply`        | `database`, `key`, `changes`, `options { type, guard, ttlMs? }`                                   | `{ commands }`, or `conflict` when guarded and an element changed (decision 115)                                                                 |
| `keyspace.rename`       | `database`, `key`, `to`, `overwrite`                                                              | `null`                                                                                                                                           |
| `keyspace.expire`       | `database`, `key`, `expiry` (`{ inMs }`, `{ at }` or null)                                        | `null`                                                                                                                                           |
| `keyspace.remove`       | `database`, `keys`                                                                                | the number removed                                                                                                                               |

A statement reads its first page and keeps the cursor open; the session's next statement, a
commit, rollback or mode switch, `result.release`, `session.close` and the engine's exit close it
first (decision 025). A close still in flight holds the session's next request until it settles,
at most `CURSOR_CLOSE_GRACE_MS` (5 s); past that the engine drops the session and reconnects, the
answer's `reconnected.reason` is `resultNotClosed`, and an open transaction fails
`transactionLost` instead. A plugin's `sessionBusy` is logged as an engine error and the request
runs once on a fresh session (`reason: "sessionBusy"`). Cancel while the request waits cancels it
before it reaches the plugin (decision 058). `result.fetchMore` calls on one handle run one after another; a cursor error
closes it and answers `statementFailed`. An export runs as a task of the engine, not of the
request: `export.start` answers at once, and the engine pushes `export.progress` (at most every
250 ms) and one of `export.done`, `export.failed` or `export.cancelled` to every renderer port,
each a message with `id: null` carrying the whole `ExportTask`. See Export. An import is the same
kind of task: `import.progress`, `import.done`, `import.failed` and `import.cancelled` carry the
whole `ImportTask`. See Import. A script run too: `script.progress` (at most every 200 ms),
`script.done`, `script.failed` and `script.cancelled` carry the whole `ScriptTask` `{ taskId, files,
file, namespace, state, statements, bytes, size, elapsedMs, error, failed, failures, question }`; a
failure's `ScriptError` adds the `file`, the statement's `line` and `column`, the start of the
`statement`, and `at`, the error's own `{ line, column }` in the file or `null`. `failed` counts the
failures the run went past, `failures` keeps the first 100 and `question` is the failure waiting on
`script.answer`. See Run SQL Script.
A statement still running when its session closes is answered with `unknownSession`.
`script.split` needs no session; it runs the plugin's `language` in the engine, so the renderer
never parses SQL (decision 008). `transactionOpen` is `false` on a plugin without `transactions`,
and `transaction.*` on one answers `invalidRequest`.

The `server.*` and `keyspace.*` requests other than `keyspace.open` run on the engine's helper
session, opened on first use like the introspection session; a command datasource's completion,
inspections and Sessions view use it too. `statement.execute`'s `node` (`auto`, `allPrimaries` or
a node id) reaches the plugin as `ExecuteOptions.node`, and its answer carries `reply` for a
command's scalar answer, held as a one-row `value` result, and `source` for the one key it read;
`result.editable` adds that `key` when a whole-key result is editable (decision 119).

The `catalog.*` requests need `schemaTree` and run on one introspection session per engine, opened
on first use and closed with the engine, never on a console's session. The engine caches the
namespace list and each described catalog (`core/catalog/cache.ts`) with when it was introspected
and how long it took; `refresh` asks again, and a second describe of a path in flight joins the
first. The cache dies with the engine, so a disconnect or an engine exit forgets it.

| Constant               | Value   | Meaning                                                                     |
| ---------------------- | ------- | --------------------------------------------------------------------------- |
| `RESULT_WINDOW_ROWS`   | 500     | Rows per window; `firstWindow` is the window at offset 0                    |
| `RESULT_PAGE_ROWS`     | 500     | The default `pageRows`: rows a statement and each Fetch Next Page read      |
| `RESULT_FETCH_ALL_CAP` | 100 000 | The default `fetchAllCap`: rows Fetch All stops at; the cursor closes there |

`pageRows` (10–10,000) and `fetchAllCap` (1,000–1,000,000, at least `pageRows`) are the Data
Editor settings, sent with every `statement.execute`, `table.query` and `result.fetchMore`, so the
engine holds no preferences (decision 032). A result keeps the paging it ran with; a change in
Settings applies to the next statement (decision 025).

The engine keeps a console's session healthy (decision 054). Every connection it opens asks for TCP
keepalive with the datasource's `keepAliveSeconds` (0 off). `timeoutSeconds` (0–86,400, absent or
0 waits), resolved by the renderer from the datasource and the `console.statementTimeoutSeconds`
setting, limits a statement until its first page arrives: past it the engine cancels and answers
`statementTimedOut`, and drops the session when the cancel goes unanswered for `CANCEL_GRACE_MS`.
Before a statement on a session idle for the keepalive interval, a `keepAlive` plugin's `ping`
runs, bounded by `PING_TIMEOUT_MS`; a failed ping, or an `execute` rejecting `connectionLost`,
opens a new session, restores manual mode, and runs the statement there; the result carries
`reconnected { namespace, namespaceLost, reason? }`. While a statement runs a whole keepalive interval, the
engine opens a probe connection; one that neither connects nor fails within `PROBE_WINDOW_MS`
fails the statement `connectionLost` and the next request reconnects. A session lost with a
transaction open fails `connectionLost` instead of reconnecting silently. Exports and imports run
on sessions of their own with keepalive but outside this watch: no statement timeout, ping, probe
or reconnect touches them, since a reconnect mid-import would lose its open transaction; only the
Transfer stall timeout ends one (decisions 040, 046).

| Constant          | Value | Meaning                                                            |
| ----------------- | ----- | ------------------------------------------------------------------ |
| `PING_TIMEOUT_MS` | 5 000 | How long a ping before a statement may take                        |
| `CANCEL_GRACE_MS` | 5 000 | How long a timed-out statement may take to end after its cancel    |
| `PROBE_WINDOW_MS` | 5 000 | How long a probe connection may stay silent while a statement runs |

### engine.error

`{ id, type: "engine.error", error: { code, message, hint, position? } }`. `id` is `null` only when
the request was unreadable. `hint` says what to do next. `position`, on `statementFailed` only, is
the UTF-16 offset in the request's SQL where the database says the statement failed, read by the
plugin from its driver's error (`PluginError.position`); a statement run with bound parameters
carries none, since binding rewrote the text (decision 082).

| Code                  | Raised when                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `unknownPlugin`       | No plugin has the datasource's `pluginId`                                |
| `pluginUnavailable`   | The plugin exists but failed to load; the message carries the reason     |
| `invalidConfig`       | The datasource config fails the plugin's `connectionSchema`              |
| `unknownSession`      | `sessionId` is not open on this port                                     |
| `unknownHandle`       | The handle was released, or belongs to another port                      |
| `connectionFailed`    | The plugin could not connect; the message is the driver's                |
| `statementFailed`     | The database rejected the statement; the message is the driver's         |
| `cancelled`           | `statement.cancel` stopped the statement                                 |
| `introspectionFailed` | The database refused to describe a namespace; the hint says Synchronize  |
| `definitionNotFound`  | `catalog.definition` named a relation the database no longer has         |
| `explainUnsupported`  | `statement.explain` got a statement the plugin cannot explain; why       |
| `timedOut`            | Test Connection got no answer within `PROBE_TIMEOUT_MS`                  |
| `statementTimedOut`   | A statement ran past its `timeoutSeconds` and was cancelled              |
| `connectionLost`      | The session was lost with a transaction open, or while a statement ran   |
| `editRejected`        | Submit rolled back; `statementIndex` names the failing statement         |
| `invalidRequest`      | The request did not parse, or asks a plugin for a capability it lacks    |
| `sshAuthFailed`       | The bastion refused the SSH user, password, key or agent                 |
| `sshHostUnreachable`  | The bastion did not answer, or the SSH handshake failed                  |
| `sshHostKeyChanged`   | The bastion's key differs from the recorded one; names both and the file |
| `sshHostKeyUnknown`   | The user did not trust the bastion's key, or no window could ask         |
| `sshTunnelLost`       | The SSH connection under the session dropped                             |
| `internal`            | Anything else; a bug                                                     |

## Shell and actions

One window, laid out the way DataGrip is (`datagrip-inventory.md` §1): the main toolbar as its
title bar (see Window and main toolbar), a left stripe and the Database tool window, the editor's tabs in the middle, the Services tool window at
the bottom, an empty right stripe, and a status bar. Which tool windows are open, their sizes, and
the share of a console tab the SQL editor takes above its results (one split for every console,
50% at first, kept between 10% and 90%, saved only when dragged) persist in the renderer's
`localStorage` under `table-craft.layout.v1`; a value that does not parse falls back to the default
layout.

The editor supports at most two side-by-side tab groups (decision 121). Drag a tab to the left or
right drop target, or use its **Split Left** / **Split Right** context-menu actions. A split moves
the existing tab; it never duplicates a session or its results. Each group has its own active tab.
Clicking or focusing a group's content makes its active tab the command target, including Run,
new consoles and the status bar. Tab cycling and bulk closes affect that group only. **Unsplit**
joins both strips, preserving pinned tabs; an empty group collapses automatically.

The vertical separator between groups is keyboard accessible and resizable from 25% to 75%,
starting at 50%. Its width, saved console/table group membership, each group's selected tab and
the focused tab persist in the existing layout document. Older documents open in one group.
The editor/results split within each console stays separate and keeps its existing behavior.

Each console tab belongs to one datasource and owns a session on that datasource's engine; closing
the tab sends `session.close`. The tab reads `console [name]`, and a datasource's colour tints its
tabs and its console's border; a read-only one shows a lock. The Database tool window shows the
datasource list (see Datasources and secrets); Services is the session tree of the open console and
table tabs with their recent executions (see Query history and Services). The status bar shows the active console's datasource,
or the selected tree node's, as "pg · connected · PostgreSQL 17.4", or the connect error's message,
and the namespace's last synchronization (see Database explorer) on the left, and a running
indicator on the right; later plans add items to its slot list (`renderer/shell/statusItems.tsx`).

Every command is an action in one registry (decision 015, `renderer/actions/`). Buttons, the
keymap, the palette and the native menu all call `invoke(id, args?)`, which answers `ran`,
`disabled` or `unknown`. An action's `when(context)` decides whether it is enabled from a snapshot
of the stores; a disabled action shows greyed and does not run. An action whose `available(context)`
is false, because the plugin lacks the capability it needs, is left out of the palette and does not
run either.

| Action id                                | Title                                 | macOS    | Windows / Linux        |
| ---------------------------------------- | ------------------------------------- | -------- | ---------------------- |
| `console.run`                            | Run                                   | `⌘↩`     | `Ctrl+Enter`           |
| `console.runAll`                         | Run All                               | `⇧⌘↩`    | `Ctrl+Shift+Enter`     |
| `console.cancel`                         | Cancel                                |          |                        |
| `console.gotoError`                      | Next Error                            | `F2`     | `F2`                   |
| `console.gotoPreviousError`              | Previous Error                        | `⇧F2`    | `Shift+F2`             |
| `console.showError`                      | Go to Error                           |          |                        |
| `console.errorSkip`, `…SkipAll`          | Skip, Skip All Failed Statements      |          |                        |
| `console.errorStop`, `…Retry`            | Stop at, Retry Failed Statement       |          |                        |
| `console.explain`                        | Explain Plan                          | `⇧⌘E`    | `Ctrl+Shift+E`         |
| `console.explainAnalyze`                 | Explain Analyse                       |          |                        |
| `plan.rerun`, `plan.copy`                | Explain Again, Copy Raw Plan          |          |                        |
| `plan.showTree`, `plan.showRaw`          | Show Plan Tree, Show Raw Plan         |          |                        |
| `console.new`                            | New Console                           | `⇧⌘L`    | `Ctrl+Shift+L`         |
| `file.open`                              | Open File…                            | `⌘O`     | `Ctrl+O`               |
| `file.openRecent`                        | Recent Files…                         |          |                        |
| `file.save`                              | Save                                  | `⌘S`     | `Ctrl+S`               |
| `file.saveAs`                            | Save As…                              | `⇧⌘S`    | `Ctrl+Shift+S`         |
| `console.rename`                         | Rename File…                          |          |                        |
| `file.reload`, `file.keepMine`           | Reload from Disk, Keep My Changes     |          |                        |
| `database.runSqlScript`                  | Run SQL Script…                       |          |                        |
| `script.cancel`                          | Cancel SQL Script                     |          |                        |
| `script.goTo`                            | Go to Failed Script Statement         |          |                        |
| `script.dismiss`                         | Remove Finished SQL Script            |          |                        |
| `script.skip`, `script.skipAll`          | Skip, Skip All Failed Script Stmts    |          |                        |
| `script.stop`, `script.retry`            | Stop at, Retry Failed Script Stmt     |          |                        |
| `transaction.commit`                     | Commit                                | `⌥⇧⌘↩`   | `Ctrl+Alt+Shift+Enter` |
| `transaction.rollback`                   | Rollback                              |          |                        |
| `transaction.toggleMode`                 | Toggle Transaction Mode (Auto/Manual) |          |                        |
| `result.pin`                             | Pin Result Tab                        |          |                        |
| `grid.fetchNextPage`                     | Fetch Next Page                       |          |                        |
| `grid.fetchAll`                          | Fetch All                             |          |                        |
| `grid.cancelFetch`                       | Cancel Fetch                          |          |                        |
| `grid.rerun`                             | Rerun                                 | `⌘R` ²   | `Ctrl+R` ²             |
| `grid.copy`                              | Copy                                  | `⌘C` ²   | `Ctrl+C` ²             |
| `grid.selectAll`                         | Select All Rows                       | `⌘A` ²   | `Ctrl+A` ²             |
| `grid.export`                            | Export Data…                          |          |                        |
| `grid.toggleValuePanel`                  | Value Panel                           | `⇧↵` ²   | `Shift+Enter` ²        |
| `grid.setExtractor`                      | Choose Extractor                      |          |                        |
| `grid.sort`, `grid.clearSort`            | Sort, Clear Sort                      |          |                        |
| `grid.hideColumn`, `grid.showAllColumns` | Hide Column, Show All Columns         |          |                        |
| `grid.copyColumnName`                    | Copy Column Name                      |          |                        |
| `grid.find`                              | Find in Result                        | `⌘F` ⁵   | `Ctrl+F` ⁵             |
| `grid.findNext`                          | Find Next                             | `↩` ⁶    | `Enter` ⁶              |
| `grid.findPrevious`                      | Find Previous                         | `⇧↩` ⁶   | `Shift+Enter` ⁶        |
| `grid.closeFind`                         | Close Find                            | `⎋` ⁶    | `Escape` ⁶             |
| `grid.findMatchCase`                     | Match Case                            |          |                        |
| `grid.findRegex`                         | Regular Expression                    |          |                        |
| `grid.findWholeCell`                     | Whole Cell                            |          |                        |
| `grid.filterRows`                        | Filter Rows                           |          |                        |
| `grid.searchAll`                         | Search All Rows                       |          |                        |
| `grid.filterByValue`                     | Local Filter: This Value              |          |                        |
| `grid.excludeValue`                      | Local Filter: Exclude This Value      |          |                        |
| `grid.filterIsNull`                      | Local Filter: Is NULL                 |          |                        |
| `grid.filterIsNotNull`                   | Local Filter: Is Not NULL             |          |                        |
| `grid.removeFilter`                      | Remove Local Filter                   |          |                        |
| `grid.clearFilters`                      | Clear Local Filters                   |          |                        |
| `tab.close`                              | Close Tab                             | `⌘W`     | `Ctrl+W`               |
| `tab.closeOthers`                        | Close Other Tabs                      |          |                        |
| `tab.closeAll`                           | Close All Tabs                        |          |                        |
| `tab.next`                               | Select Next Tab                       | `⇧⌘]`    | `Ctrl+Shift+]`         |
| `tab.previous`                           | Select Previous Tab                   | `⇧⌘[`    | `Ctrl+Shift+[`         |
| `toolWindow.database.toggle`             | Database                              | `⌘1`     | `Ctrl+1`               |
| `toolWindow.services.toggle`             | Services                              | `⌘8`     | `Ctrl+8`               |
| `toolWindow.hideAll`                     | Hide All Tool Windows                 | `⇧⌘F12`  | `Ctrl+Shift+F12`       |
| `focus.editor`                           | Back to Editor                        | `⎋`      | `Esc`                  |
| `palette.findAction`                     | Find Action…                          | `⇧⌘A`    | `Ctrl+Shift+A`         |
| `palette.searchEverywhere`               | Search Everywhere                     | `⇧⇧`     | Double Shift           |
| `datasource.new`                         | New Data Source…                      | `⌘N` ¹   | `Ctrl+N` ¹             |
| `datasource.import`                      | Import Data Sources…                  |          |                        |
| `datasource.properties`                  | Data Source Properties…               | `⌘;`     | `Ctrl+;`               |
| `datasource.switchTo`                    | Switch to Data Source                 |          |                        |
| `datasource.duplicate`                   | Duplicate Data Source                 | `⌘D` ¹   | `Ctrl+D` ¹             |
| `datasource.copyUrl`                     | Copy as URL                           |          |                        |
| `datasource.delete`                      | Delete Data Source                    | `⌦` ¹    | `Delete` ¹             |
| `datasource.connect`                     | Connect                               |          |                        |
| `datasource.disconnect`                  | Disconnect                            | `⌘F2`    | `Ctrl+F2`              |
| `datasource.newFolder`                   | New Folder…                           |          |                        |
| `datasource.moveToFolder`                | Move to Folder…                       |          |                        |
| `database.synchronize`                   | Synchronize                           | `⌥⌘Y`    | `Ctrl+Alt+Y`           |
| `explorer.collapseAll`                   | Collapse All                          | `⌘-` ¹   | `Ctrl+-` ¹             |
| `explorer.toggleSystemSchemas`           | Show System Schemas                   |          |                        |
| `explorer.copyName`                      | Copy Qualified Name                   | `⌥⇧⌘C` ¹ | `Ctrl+Alt+Shift+C` ¹   |
| `explorer.reveal`                        | Select in Database View               |          |                        |
| `explorer.export`                        | Export Data…                          |          |                        |
| `explorer.importIntoTable`               | Import Data from File…                |          |                        |
| `explorer.importNewTable`                | Import Data into New Table…           |          |                        |
| `explorer.newTable`                      | New Table…                            |          |                        |
| `explorer.newSchema`                     | New Schema…                           |          |                        |
| `explorer.newDatabase`                   | New Database…                         |          |                        |
| `explorer.modifyTable`                   | Modify Table…                         | `⌘F6`    | `Ctrl+F6`              |
| `explorer.renameObject`                  | Rename…                               | `⇧F6`    | `Shift+F6`             |
| `explorer.truncateTable`                 | Truncate…                             |          |                        |
| `explorer.dropObject`                    | Drop…                                 | `⌘⌫`     | `Ctrl+Backspace`       |
| `history.show`                           | Query History…                        | `⌥⌘E`    | `Ctrl+Alt+E`           |
| `history.clear`                          | Clear Query History…                  |          |                        |
| `console.reopen`                         | Open Closed Console…                  |          |                        |
| `services.cancel`                        | Cancel Running Statement              |          |                        |
| `export.cancel`                          | Cancel Export                         |          |                        |
| `export.retry`                           | Retry Export                          |          |                        |
| `export.reveal`                          | Reveal Exported File                  |          |                        |
| `export.dismiss`                         | Remove Finished Export                |          |                        |
| `import.cancel`                          | Cancel Import                         |          |                        |
| `import.resume`                          | Resume or Retry Import                |          |                        |
| `import.revealRejected`                  | Reveal Rejected Rows                  |          |                        |
| `import.dismiss`                         | Remove Finished Import                |          |                        |
| `services.clearExecutions`               | Clear Executions                      |          |                        |
| `services.copySql`                       | Copy Execution SQL                    |          |                        |
| `services.openInConsole`                 | Open Execution in Console             |          |                        |
| `settings.show`                          | Settings…                             | `⌘,`     | `Ctrl+,`               |
| `editor.zoomIn`                          | Increase Editor Font Size             | `⌘=` ³   | `Ctrl+=` ³             |
| `editor.zoomOut`                         | Decrease Editor Font Size             | `⌘-` ³   | `Ctrl+-` ³             |
| `editor.zoomReset`                       | Reset Editor Font Size                | `⌘0` ³   | `Ctrl+0` ³             |
| `app.mainMenu`                           | Main Menu                             |          | Alt alone ⁴            |
| `app.relaunch`                           | Restart Now                           |          |                        |

¹ Only with focus in the Database tool window (`shortcutRegion`); elsewhere the key reaches the
focused element. ² Only with focus in a result grid (region `grid`); in the editor and
the value panel ⌘C and ⌘A stay native. The datasource actions act on the selected tree node with focus in the Database
tool window, else on the active console's datasource. `console.new` opens on that datasource too.
³ Only with focus in the SQL editor (region `editor`), so `⌘-` in the Database tool window is still
Collapse All (decision 027).
⁴ Not a keymap chord: main watches a lone Alt press in `before-input-event` and pops the menu
itself. Main Menu is available on Windows and Linux with the custom title bar only.
⁵ With focus in a result grid or its find bar (regions `grid`, `gridFind`); in the SQL editor ⌘F
stays CodeMirror's search.
⁶ Only with focus in the find bar (region `gridFind`), so `⇧↩` in the grid is still Value Panel.

Shortcuts are declared as platform-neutral chords (`Mod+Shift+A`, `Shift Shift`) and dispatched by
one capture-phase `keydown` listener on the window. A chord whose action is disabled reaches the
focused element; no two actions share a chord (a unit test checks the registry). While the palette
is open the keymap stands aside. Hide All Tool Windows restores what it hid when pressed again with
nothing open. Back to Editor applies only with focus in a tool window; `shortcutRegion` may name
several regions. With focus in the SQL editor the keymap also stands aside for the chords CodeMirror
owns, `EDITOR_CHORDS` in `renderer/console/editorKeys.ts` (`⌘Z`, `⇧⌘Z`, `⌘A`, `⌘F`, `⌘/`, `⌘D`,
`Esc`, `⌃Space`); a unit test fails when an action that can fire in the editor takes one of them.

Find Action (`⇧⌘A`) and Search Everywhere (`⇧⇧`) are one palette. Search Everywhere has scope tabs,
`All`, `Actions` and `Tables`, fed by `SearchProvider`s (`renderer/palette/providers.ts`); `Tab` moves between
them. Results are ranked by an in-house fuzzy scorer, and with an empty query the most recently
run actions come first.

The native menu is declared in `preload/menu.ts` and built by main. On macOS the app menu is
explicit: About, Settings… (`⌘,`), Services, Hide, Hide Others, Show All, Quit. Then File (New Data
Source…, New Console; Data Source Properties…, Disconnect, Synchronize; Settings… on Windows and
Linux only; Close Tab),
Edit (role), View (Tool Windows ▸ Database, Services; Hide All Tool Windows; Show System Schemas;
Query History…, Open Closed Console…; Find Action…; Search
Everywhere; Toggle Developer Tools), Window (role, macOS only), Help (Find Action…; About
TableCraft on Windows and Linux only, which shows the name, version, Electron and Chromium; macOS
has the standard About panel with the same version). An item shows its
action's accelerator with `registerAccelerator: false` and, when clicked, sends the action id to
the renderer on `table-craft:invoke-action`; main never decides whether an action is enabled.
On Windows and Linux the menu bar is hidden while the window draws its own title bar; the same menu
pops up under the main-menu button (`app.mainMenu`, which asks main over `table-craft:menu.popup`
with the button's bottom-left corner) or when Alt is pressed and released alone (`createLoneAlt` in
`main/menuPopup.ts`, anchored under the button). With the system title bar the menu bar is back.

### Window and main toolbar

The window has no system title bar (decision 034). The main toolbar, `renderer/shell/MainToolbar.tsx`,
is its title bar: a `role="toolbar"` strip named "Main toolbar", `titleBarHeightPx` high (40 px
comfortable, 32 px compact) in the panel colour with a bottom border. Left to right it holds:

- on macOS, an empty inset of `TRAFFIC_LIGHT_INSET_PX` (76 px) for the traffic lights, dropped in
  full screen; on Windows and Linux, the main-menu button (`app.mainMenu`);
- the datasource widget (`shell/DatasourceWidget.tsx`): the active datasource's tint swatch, name
  and status dot, or "No data source". It opens a popover, "Switch data source", listing every
  datasource with its swatch and connected state, then New Data Source… and Data Sources…. Choosing
  one runs `datasource.switchTo`, which activates that datasource's most recently active console or
  table tab, else opens a console on it;
- the window title, centred, muted and truncating: the active tab's caption, `console [pg]`;
- the run widget: Run, Cancel, Commit and Rollback, icon-only with tooltips. Cancel needs the
  `cancel` capability and Commit and Rollback the `transactions` one; an action that is not
  available (`available(context)` false) is not drawn;
- Search Everywhere, the Update button when there is an update to show (see In-app update), and
  Settings….

Every button is an action button (`ui/ActionButton.tsx`) that invokes its action and keeps focus
where it was (`mousedown` is prevented), so Run from the toolbar runs the statement at the caret.
The console toolbar keeps its own Run, Cancel, Commit and Rollback; it is named "Console toolbar".
`document.title` is `windowTitle(tab, datasource)` (`model/windowTitle.ts`), `console [pg] —
TableCraft` or `TableCraft`, which Electron mirrors to the window's title for the Dock, the
taskbar and the window switcher.

Main builds the window chrome in one pure function, `windowChrome({platform, theme, density,
systemTitleBar})` in `main/chrome.ts`:

| Platform         | Window options                               | Native controls                                               |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------- |
| macOS            | `titleBarStyle: "hiddenInset"`               | traffic lights at `{x: 12, y: (height − 14) / 2}`             |
| Windows, Linux   | `titleBarStyle: "hidden"`, `titleBarOverlay` | caption buttons on `{color: panel, symbolColor: ink, height}` |
| system title bar | none                                         | the platform's frame                                          |

`applyWindowAppearance` re-applies the overlay (`setTitleBarOverlay`) and the traffic lights
(`setWindowButtonPosition`) with the background whenever the theme or density changes. On Windows
and Linux the toolbar's right padding keeps its controls clear of the overlay
(`env(titlebar-area-width)`). The toolbar is the window's drag region (`.app-drag`); every control
in it is `.app-no-drag`, and double-click is left to the system. Main sends
`table-craft:window.state-changed` with `{fullScreen, customTitleBar}` on entering and leaving full
screen and answers `table-craft:window.state` at startup (`state/windowState.ts`).

With Use system title bar (see Settings and appearance), read once when the window is created, the
window keeps its platform frame: the toolbar still shows, with no inset, main-menu button or drag
region, and Windows and Linux show their menu bar.

## SQL console

A console is a CodeMirror 6 editor (`renderer/console/Editor.tsx`) above its result tabs. The
plugin's manifest `highlight` picks the `lang-sql` dialect (`postgresql`, `mysql`, `sqlite`,
`plsql`, `mssql`, else standard SQL). It has line numbers, bracket matching, line comments (`⌘/`), search (`⌘F`), multiple
cursors, undo and completion (see Completion and navigation); its colours and font are the editor and syntax tokens, read
as CSS variables (`renderer/console/editorTheme.ts`). The datasource colour tints the editor's
border. The editor's accessible name is `SQL console`.

### Snippets

**Snippets…**, available through Find Action, manages profile-local text templates for SQL and
command consoles (decision 123, superseding decision 122's SQL-only scope). Its searchable master/detail manager supports create, read, update and delete, with a body
preview, validation, unsaved-edit guards and actionable load/save errors. A new profile has no
seeded snippets.

Each `TextSnippet` is `{ id, name, prefix, body, scope }`. Scope means all text consoles, all SQL
consoles, or one plugin identity. A migrated legacy SQL scope may additionally retain its old
highlight restriction; that restriction is migration compatibility, not a new plugin selector.
Eligibility requires `sql` or `commands`; the scope then filters eligible consoles. All SQL never
includes a command-only console. A per-plugin scope matches manifest id, not `highlight` or one
datasource id. **Applies to** lists installed eligible plugins dynamically by id/name, without
hardcoded plugin identities. New drafts default to the active datasource type, otherwise all
consoles. An unavailable saved scope must remain intact rather than silently becoming broader.

The editor is labeled **Snippet body**. The manager preview always renders plain text, without
syntax highlighting. Console highlighting separately follows capability and language metadata,
not scope identity. Unknown command highlighters render plain text and do not receive SQL keyword
completion. Template editing and native expansion work offline; SQL/command language services
remain the plugin's responsibility.

Prefix matches join the completion popup without replacing engine or keyword suggestions. `Tab`
or `Enter` accepts the selected snippet; during field editing `Tab` and `Shift+Tab` navigate the
fields without breaking ordinary completion or indentation outside a snippet. `${table}`,
`${schema}` and arbitrary named fields are editable text, not database-autofilled values. Repeated
names are linked. `${cursor}` is a final zero-width caret stop, not an editable field or literal
text. Expansion uses native CodeMirror snippet support, with no new dependency or SQL parser in
the renderer. It inserts text only; execution and its guards are unchanged.

Main owns the strict version-2 `<userData>/snippets.json` document and serializes atomic CRUD writes.
It also accepts strict version-1 SQL documents: `dialect: null` becomes all SQL, and a string becomes
a legacy SQL scope retaining that highlight. Migration is in memory on read, never a read-triggered
write. The next successful CRUD mutation atomically writes version 2. Ids, names, prefixes, bodies
and restrictions are preserved; old all-SQL snippets never broaden to all consoles. Invalid
documents and failed writes leave prior content intact and report actionable errors.
Typed, validated IPC carries snippet operations through preload; the renderer never accesses the
file directly. The document is separate from `settings.json`, contains plain-text user content,
and is not a secret store. Invalid documents and I/O failures must be reported rather than silently
overwriting the user's templates. No plugin API or engine language contract changes are required.
No driver, dependency or future database plugin is added. A future plugin can participate through
the existing SQL/command text-console hooks; that does not itself provide execution support for
etcd, Kafka, MongoDB or another system.

### Run scopes

The renderer sends the text to `script.split` only when the user runs, and picks the statements
with `renderer/model/statementAt.ts`:

| Run                | Caret or selection                         | Runs                                                       |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| `console.run` (⌘↩) | caret inside a statement                   | that statement                                             |
|                    | caret in whitespace or a comment after one | the statement before it                                    |
|                    | caret before the first statement           | the first statement                                        |
|                    | any selection                              | the selected text, split into statements, at their offsets |
|                    | selection of only whitespace or comments   | nothing; Output says `Nothing to run`                      |
| `console.runAll`   | anything                                   | every statement                                            |
| either             | no statements                              | nothing; Output says `Nothing to run`                      |

The statement about to run flashes in the editor. Statements run one after another on the
console's session; a cancel stops the batch, and Output says how many were skipped. Before
anything runs, every destructive statement in the batch is listed in one dialog
with its reason, Execute or Cancel; Cancel runs nothing and logs `Cancelled; nothing ran.`.

When `console.parameters` is on and the batch has parameters, the Parameters dialog asks next: one
row per distinct name across the batch (each `?` numbered `?1`, `?2`… across the whole batch), a
value or NULL, and the statements with their markers highlighted. Run sends the values as
`statement.execute`'s `parameters`, keyed by each statement's own names; the engine binds them with
the plugin's `bind` and the driver's placeholders, never into the text. Cancel runs nothing and
logs `Cancelled; nothing ran.`. The console remembers the values for the next prompt, the history
records them with the statement, and restoring it from Query History seeds them. With the setting
off the text runs verbatim. Explain sends its statement verbatim. Rerun asks again.

#### Errors in a run

A failed statement is underlined where the database says it failed (decision 082): the engine's
`position` plus the statement's offset in the console, widened to the whole word, drawn as a wavy
`--tc-danger` underline with a gutter dot and a hover showing the message and hint. The marks live
in the console's state, move with edits, and go when an edit touches their statement or a run
runs it again; a mark is set only while the text still equals what ran. **Go to Error**
(`console.showError`) beside Show in Log puts the caret on the toolbar error's mark; **Next Error**
(`console.gotoError`, F2) and **Previous Error** (`console.gotoPreviousError`, ⇧F2) step through
the marks after or before the caret, wrapping.

A run of more than one statement follows `console.runAllOnError` when a statement fails with
`statementFailed` or `statementTimedOut` (decision 083); any other error, and a cancel, stops it:

| Setting    | On a failed statement                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| `ask`      | the run pauses; a banner above the result tabs asks Skip, Skip All, Stop or Retry         |
| `stop`     | the run stops; Output says how many statements were skipped                               |
| `continue` | Output logs the failure and the run goes on; it ends with the warning `12 run, 2 failed.` |

The banner reads `Statement 3 of 12 failed: <message>`; the console's status reads `Waiting on
the failed statement…`. Skip goes on, Skip All goes on without asking again, Stop is the `stop`
row, and Retry runs the statement again. `console.cancel` and closing the console answer Stop. The
last statement's failure asks nothing. A run that went past a failure ends with the summary
warning and shows Output. Continuing inside an open transaction logs once that some databases,
PostgreSQL among them, refuse every later statement until it is rolled back.

`console.reformat` (Reformat Code, ⌥⌘L) sends the selection, or the whole text when there is none,
to `sql.format` with the `editor.format` settings and replaces it in one undoable edit; the caret
stays on the token it was on. A failure is logged to Output with the reason and leaves the text.

While the destructive, Parameters or Explain Analyse dialog is open the console's status reads `Waiting for confirmation…`,
and the run's timer starts when it is answered. Run on a disconnected console connects first
(decision 021).

### Results and Output

Under the editor sit `Output` and one tab per statement that returned rows, `Result 1`,
`Result 2`…, with the SQL as the tooltip; each holds a `ResultGrid` over its own handle. A new run
releases the unpinned result tabs and numbers new ones after the pinned; the pin on a tab
(`result.pin`) keeps it across runs. The last tab a run opens is shown, or `Output` when the run
failed. An explain opens a plan tab instead (see Explain); result and plan tabs share the strip,
the pin and the replacement rule.

Output is a log per console, in memory and capped at `OUTPUT_LIMIT = 500` entries: the time, the
first line of the SQL, then `2 rows retrieved in 38 ms` (`500+ rows retrieved` while the cursor has
more), `1 row affected in 12 ms`, `completed in 4 ms` for statements that are not writes,
`Cancelled`, `50,000 rows exported to /path/a.csv (1.8 MB) in 120 ms`, or the error with its hint.
Commit, Rollback, skipped statements and a session lost with its transaction are logged too. A
statement's error also shows in the toolbar.

The warnings and notices the server left about a statement (decision 066, capability
`serverMessages`) follow its line, one entry each in the level's tone: `Warning 1815: …`,
`Note 1003: …`, `Error …`, `Info …`. At most `SERVER_MESSAGE_LIMIT = 100`, then one line saying how
many more. A statement with warnings is still a success. Its result or plan tab carries a warning
badge with the count, the messages as its tooltip, and so does its execution in Services; history
keeps the count, never the text. A streamed result's messages arrive with the page that completes
it.

### Result grid

Plan 007. `renderer/grid/ResultGrid.tsx` draws a result as DataGrip does: a toolbar, a sticky
header and row-number gutter, virtualized rows, and an optional value panel on the right.

**Paging.** A statement answers with its first page, Settings' page size (500 by default), and an
open cursor (decision 025). The toolbar reads, left to right: Fetch Next Page, Fetch All, Rerun, Cancel fetch
while a fetch runs, the state label, then the extractor select, Copy, Export Data… and Value Panel.

| Label                                    | When                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `5,000 rows`                             | Everything was read                                            |
| `500+ rows`                              | The cursor is open; Fetch Next Page and Fetch All are enabled  |
| `500+ rows · fetching stopped`           | Something closed the cursor first; Rerun runs it again         |
| `100,000+ rows · fetch cap reached`      | Fetch All stopped at Settings' Fetch All limit                 |
| `… · sorted locally`                     | Appended while a local sort is on a result not completely read |
| `1,284 of 5,000 rows · filtered locally` | A local filter hides rows (decision 050)                       |

**Columns.** The header shows the column name with a type glyph (number, text, date, bool, json,
bytes) from the plugin's `Column.typeClass` when it names one, else core's `typeClass` of the type
name (decision 101); a column the driver did not type takes the class of its first non-null value. The tooltip is `name: type`. Numbers are right-aligned. A column starts as wide as
its header and the widest value loaded so far, capped at `--spacing-column-max`; dragging the
header's right edge resizes it (at least 40 px) and double-clicking fits it to its loaded values.
The header context menu holds Sort Ascending, Sort Descending, Clear Sort, Hide Column, Show All
Columns and Copy Column Name. Widths, hidden columns and sort belong to the result tab
(`model/columnLayout.ts`) and survive Rerun when the column names are the same.

**Sort.** Clicking a header cycles ascending, descending, none on that column alone; ⌥-click adds
the column as the next key or cycles it in place, and the header shows its arrow and position.
`result.sort` sorts the rows the engine holds through a permutation, comparing by type class:
numbers and decimal text numerically and exactly, booleans false first, everything else by code
point; `NULL` sorts last ascending and first descending. Rows fetched later take their sorted
places.

**Find and local filter.** Plan 023, decision 050. `grid.find` (⌘F with focus in the grid) opens a
find bar under the toolbar: the query, Match Case, Regular Expression and Whole Cell toggles, the
count (`3 of 1,284`, `No matches`, or `Invalid regular expression: <reason>`), previous and next,
Filter Rows and Close. Typing settles for 120 ms, then the renderer sends a `ViewSpec` (query,
`rowsOnly`, chips, the visible columns in drawing order, Group digits) with `result.view`. The
engine matches each cell's display text, the text the grid draws without the NULL text: the
database's text, digits grouped when the setting is on; a `NULL` cell never matches find. It walks
the held rows once, in sort order, keeping the shown rows' sources and the matched cells; windows
then read through that view and carry their `[row, column]` matches, highlighted with
`bg-search-match` (the current one bold, scrolled into view in both directions). `↩`/`⇧↩` in the
bar, or the arrows, ask `result.findMatch` from the focused cell and wrap. The header menu's Local
filter section adds chips from the focused row's value: equals or excludes its database text, Is
NULL, Is Not NULL; chips always hide rows, Filter Rows hides rows without a match only while the
bar is open. Both cover the fetched rows only: the state label reads `1,284 of 5,000 rows ·
filtered locally` (`+` while the cursor is open), the bar says `Searched 500 fetched rows` or that
the fetch cap is reached, and **Search All Rows** is Fetch All, after which the view covers every
fetched row. Fetching, sorting, hiding a searched column and Rerun (when the layout is kept)
recompute the view. Copy and Select All take shown rows; Export asks "Visible rows only (N)" or
"Whole result" when a filter hides rows, the first written from memory in the grid's order. In the
table editor the chips read `Local filter (fetched rows):` beside the server-side WHERE bar, and
pending edits keep naming held rows through `ViewState.sources`.

**Editing a console result.** Plan 026, decision 056. A console result is editable when it comes
from one plain `SELECT` over one base table whose key columns it shows; the grid then edits like
the table editor (see Table data editor), with the same actions, preview and `editRejected`. After
a run the grid asks `result.editable`: the plugin's `language.selectSource` reads the statement
(no joins, `DISTINCT`, `GROUP BY`, aggregates, window functions, set operations, `WITH` or
subqueries in `FROM`) and names the table and which result column reads which table column; the
engine checks it against the catalog (primary key, else a unique `NOT NULL` key) and the driver's
`Column.origin`. An expression, an aliased computation or a repeated column is read-only and takes
no edit; any other answer leaves the whole result read-only and the toolbar says why:
`Read-only: the result joins two or more tables`, `… has no primary key column`, `… reads a view`.

Edits run on the console's own session and follow its transaction mode. In auto mode Submit runs
them in one transaction and commits, exactly like the table editor. In manual mode they run inside
the console's transaction under a savepoint (`language.savepoint`) and stay uncommitted until
Commit or Rollback; a rejected edit rolls back to the savepoint only, so the rest of the
transaction survives. After a submit the console re-runs the statement in place. Run, Explain,
Rerun, sort, a filter change while sorted, closing the console, disconnecting and quitting with
pending edits ask Submit, Discard or Cancel (re-numbering would point edits at other rows); a
session that closes on its own discards them with a line in Output. Submit (⌘↵) in a console grid
with pending edits preempts Run (decision 057).

**Selection and copy.** Click, shift-click, drag, the arrows (shift extends), Page Up/Down,
Home/End select a rectangle; the gutter selects rows, ⌘-click on a header a column, `grid.selectAll`
every fetched row. Copy asks the engine for `result.extract` over the selection's rows and visible
columns in the chosen extractor and writes the clipboard; above `MAX_COPY_ROWS = 100_000` rows
it is disabled with the reason. The extractor is one setting in the layout, default CSV:

| Extractor   | Output                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------- |
| CSV         | Header row, RFC 4180 quoting, `\n` line ends, `NULL` empty                               |
| TSV         | Header row; tab, newline, return and backslash escaped as `\t` `\n` `\r` `\\`            |
| JSON        | An array of objects; `json` cells embedded, bigints and decimals as strings, bytes `0x…` |
| SQL Inserts | `INSERT INTO MY_TABLE (…) VALUES (…);` per row with the plugin's quoting and literals    |
| Markdown    | A pipe table; `\|` escaped, newlines as `<br>`, `NULL` empty                             |

Bytes in the grid carry only their 32-byte preview, so a longer value copies clipped (`0x…` with `…`, or a
`/* 32 of 2048 bytes */` comment after the literal).

**Selection aggregates.** Plan 043, decision 118. With two or more cells selected, a status line
under the rows shows what `result.aggregate` computes in the engine over the selected shown rows
and visible columns (the rows never leave it): Count (cells) and Distinct (non-`NULL` values)
always; Sum, Avg, Min and Max when every selected column is a number class, and Min and Max when
every one is temporal. Integers and decimals add exactly as scaled big integers, so `0.1 + 0.2`
reads `0.3`, and Avg keeps six more decimal places than its input, rounded half away from zero;
any `float` cell makes the line float arithmetic. The request settles for 120 ms after the
selection moves. Clicking the line copies it (`grid.copyAggregates`); its menu chooses the parts
shown, Settings' `data.aggregates`.

**Transpose.** `grid.transpose` (⌥⌘T, or the toolbar's toggle) draws each visible column as a row
and the records as columns, virtualised sideways; the flag belongs to the result tab's layout and
survives Rerun. Selection, focus, the editor and pending edits keep record and column coordinates,
so ← → move between records and ↑ ↓ between columns, and an edit in the transposed view hits the
same buffered cell.

**Export.** `grid.export`, and `explorer.export` on a table or view, open the Export dialog:
format (the five extractors and Excel (XLSX)), columns (the visible ones checked) and file, with
Browse… asking main for a path (`dialog.saveFile`, default name `<title>.<ext>`). The engine then
streams the rows to disk as a background task (decision 040), so a console stays usable and the
file may be many gigabytes at flat memory:

- Source. A result whose statement reads (`classify` is `read`), on a session with no open
  transaction and no private database, read in the namespace the session started in (decision 048), is re-run on a session of the export's own, read-only, with
  the datasource's TCP keepalive (decision 054) and `fullBytes` (contract 0.12.0); one statement reads one snapshot. Otherwise a
  complete result is written from memory, and an open cursor is drained (the grid shows
  Exporting… until it ends). A table export runs `SELECT <columns> FROM <table>` on its own
  session. Bytes are exported whole except from memory or a drained cursor, where the task counts
  the previews it wrote.
- File. Rows go to `<path>.<taskId>.part`, created exclusively, in 1 MiB writes that wait on the
  disk; the finished file is fsynced, renamed over `path` and its folder fsynced. A failed or
  cancelled export removes the part file and leaves an existing `path` untouched. A disk with less
  than 1 GiB free adds a warning; a full disk fails as `diskFull` naming the bytes written.
- Network. A source that delivers nothing for Settings' Transfer stall timeout (120 s) fails the task
  as `stalled`; its session is closed without waiting, and `Session.close` is bounded even on a
  dead link. A lost connection fails it as `source`. Every failure says how many rows were written
  before it stopped. Nothing resumes; **Retry** runs a re-run or table export again from row 0.
- XLSX is a streamed ZIP the engine writes itself (decision 041): one sheet per 1,048,575 rows with
  a bold frozen header, numbers and booleans typed, text cut to 32,767 characters (counted), ZIP64
  past 4 GiB.

The Services tool window lists the engine's tasks under **Exports** with progress, rows, size and
time, and **Cancel**, **Retry** and **Reveal Exported File**; the status bar shows `Exporting N`
while any runs. A console's Output logs how its exports end.

**Values.** `NULL` reads as Settings' NULL text (`<null>` by default) in `text-grid-null`
italics, unlike the text `'<null>'`. With Group digits on, a number cell (`integer`, `decimal`,
`float`) whose text is `^-?\d+(\.\d+)?$` draws `,` every three integer digits; exponents, `NaN`
and `Infinity` draw as printed. Column widths measure the drawn text. Both are display only: the
value panel, Copy, Export, the filters, the inline editor and history keep the database's text
(decision 032). The value panel (⇧↵) shows the focused cell: JSON pretty-printed in a read-only editor, text wrapped,
bytes as hex lines with `32 of 2,048 bytes shown`, `NULL` muted. A binary value also offers
**Save Value to File…** and **Load File into Cell…**, and draws a PNG, JPEG, GIF or WebP it holds
as an image (by its signature, as a `data:` URL). Main only picks the path; the engine reads and
writes the file. When the grid holds just the preview, the engine re-reads the whole value on a
read-only session by the table's key (a table tab or an editable console result; otherwise it
says to open the table). Both refuse a value larger than Settings' BLOB file limit
(`data.blobLimitMb`, 16 MiB).

**Memory.** A tab keeps at most `MAX_LOADED_WINDOWS = 20` windows of `RESULT_WINDOW_ROWS`; loading
another evicts the one furthest from it, and scrolling back fetches it again. When the engine
exits, the tab keeps its windows, shows `Results from a closed connection; rerun to refresh` and
stops fetching; Rerun reconnects (decision 021) and runs the statement again in place.

### Transactions

A console on a plugin with `transactions` shows a `Tx: Auto` / `Tx: Manual` select, Commit and
Rollback (enabled while a transaction is open) and a `transaction open` badge. Every console starts
in auto; the mode is applied when the session opens. Switching to auto, closing the console's tab,
disconnecting its datasource or quitting with a transaction open asks once, listing the consoles,
Commit, Rollback or Cancel. Quitting and closing the window wait for that answer (decision 024).

A successful `ddl` statement re-describes the datasource's cached namespaces when no transaction is
open; in an open transaction it waits for the commit, and a rollback drops it. Dragging a relation,
view or column from the Database tool window into the editor inserts its `catalog.qualifiedName`
at the drop point.

### Explain

Plan 012, decision 031. Explain Plan shows the optimiser's plan without running the statement;
Explain Analyse runs it and shows what happened. Each is a capability: PostgreSQL and MySQL declare
`explain` and `explainAnalyze`, SQLite `explain` alone, and a console shows only the buttons and
palette entries its plugin declares (an action's `available`, decision 007). The buttons follow Run
All in the console toolbar as icons (title in the tooltip), Explain Analyse in the warning tone;
the datasource name at the toolbar's end truncates when they leave it too little room.

| Action                   | Title           | macOS | Windows / Linux | Scope   |
| ------------------------ | --------------- | ----- | --------------- | ------- |
| `console.explain`        | Explain Plan    | `⇧⌘E` | `Ctrl+Shift+E`  | console |
| `console.explainAnalyze` | Explain Analyse |       |                 | console |
| `plan.rerun`             | Explain Again   |       |                 | console |
| `plan.copy`              | Copy Raw Plan   |       |                 | console |
| `plan.showTree`          | Show Plan Tree  |       |                 | console |
| `plan.showRaw`           | Show Raw Plan   |       |                 | console |

Explain Analyse has no chord, deliberately. Both take the statement at the caret or the selection,
as Run does; a selection holding several statements is refused in Output with
`Explain one statement at a time.`. The flow:

1. `script.split`, then `sql.explainable { sql, analyze }`: the plugin refuses empty input, several
   statements, a statement that is already `EXPLAIN`/`DESCRIBE`/`DESC`, and kinds the dialect cannot
   explain, with a reason; MySQL analyses only `SELECT` and `TABLE`. A refusal is an Output warning
   and nothing runs.
2. Analyse of a write asks first, in a destructive dialog titled
   `Explain Analyse runs this statement`: the statement's first line, its destructive reason if any,
   and `Its changes will be committed.` (auto) or
   `Its changes stay in the open transaction until you commit or roll back.` (manual);
   `Run and Explain` or Cancel, which runs and records nothing. Explain Plan, and Analyse of a read,
   never ask.
3. `statement.explain { sessionId, sql, analyze }` runs on the console's session: it closes the open
   cursor first, holds the session so Cancel works, and answers the plan and `transactionOpen`.

The plugin sends PostgreSQL `EXPLAIN (FORMAT JSON) …` or `EXPLAIN (ANALYZE, FORMAT JSON) …`; MySQL
`EXPLAIN FORMAT=TREE …` or `EXPLAIN ANALYZE FORMAT=TREE …`, but `EXPLAIN FORMAT=JSON …` for a
single-table `UPDATE` or `DELETE`, which `TREE` prints as `<not executable by iterator executor>`;
on TiDB, which knows neither format before v6, plain `EXPLAIN …` or `EXPLAIN ANALYZE …`, read from
its table (the tree from the `id` column's `└─`/`├─` prefixes, `estRows` or TiDB 3's `count` as the
estimate, `actRows` and the `time:` of `execution info` as actuals, `access object` as the target,
`operator info` as the detail, `task`, `execution info`, `memory`, `disk` and the `Build`/`Probe`
role as properties); SQLite `EXPLAIN QUERY PLAN …`. It reads the answer into an `ExplainedPlan`:

```ts
interface PlanNode {
  readonly operation: string; // "Seq Scan", "Nested loop inner join", "SCAN o"
  readonly target: string | null; // "orders o"
  readonly detail: string | null; // "using customers_pkey", a MySQL filter
  readonly estimatedRows: number | null;
  readonly estimatedCost: number | null;
  readonly actualRows: number | null; // analysed only
  readonly actualTimeMs: number | null; // analysed only, the node's total time
  readonly loops: number | null; // analysed only
  readonly properties: readonly { name: string; value: string }[]; // every other key, in order
  readonly children: readonly PlanNode[];
}

interface ExplainedPlan {
  readonly statement: string; // the EXPLAIN text sent
  readonly analyzed: boolean;
  readonly roots: readonly PlanNode[];
  readonly summary: readonly { name: string; value: string }[]; // Planning Time, Execution Time
  readonly raw: string; // what the database printed
  readonly messages?: readonly ServerMessage[]; // decision 066, e.g. TiDB's 1815
}
```

The plan opens in a plan tab, `Plan` or `Plan (analysed)`, which pins and is replaced like a result
tab; Output logs `Explained in N ms` or `Analysed in N ms`. `console/PlanView.tsx` draws a toolbar
(a Tree / Raw toggle, Explain Again, which explains again in the same mode and asks again when
Analyse writes, Copy Raw Plan, then the summary), and under it a tree-table (`role="treegrid"`,
the Services keyboard model, every node expanded): Operation (indented, with its target, truncated
with a tooltip), Rows (est.), Cost (est.), and when analysed Actual Rows, Time (ms) and Loops, empty
where the database gave nothing. A bar under the Cost cell, or under Time when analysed, shows the
node's share of the root's. The selected node's detail and properties fill a strip on the right.
Raw shows `raw` in a read-only editor. An analysed plan opens with a warning banner,
`Explain Analyse ran this statement.`, adding `Its changes were committed.` or
`Its changes are in the open transaction.` when it wrote.

History records the EXPLAIN text sent with its outcome and duration (the user's statement when the
explain failed); Services lists the execution as `Explain: <first line>` or
`Explain Analyse: <first line>`. An `EXPLAIN …` typed and run with Run is still rows in the grid;
only the classifier treats it differently (SQL language and transactions).

### Console files

A console on a saved datasource autosaves to `<userData>/consoles/<datasourceId>/<name>.sql`,
500 ms after the last edit (`AUTOSAVE_DELAY_MS`), when its tab closes and before the window closes.
A new console takes the first free name of `console`, `console_1`, `console_2`…, counting files and
open tabs. Closing a tab keeps its file unless the text is blank, which deletes it. Deleting a
datasource deletes its console directory; the confirmation says how many files that is. Consoles on
the `TABLE_CRAFT_DATASOURCE` datasource are not saved. A closed console's file comes back through
Open Closed Console… (see Query history and Services), which reopens it under its own name.

The layout remembers the open console tabs (`openConsoles`: datasource id, name, which is active,
and a file console's `path`). At launch they reopen with their text and their datasource
disconnected; the first Run connects, so launch makes no connections. A file that is gone or
unreadable is skipped, and one notice names it.

### File consoles

A console is a scratch console (above) or a file console, whose text is a `.sql` file anywhere on
disk (decision 080). **Open File…** picks one or more files and opens each on the data source the
file was last used with, else the focused console's or the selected tree node's, else detached: a
detached console asks for a data source on its first Run. A file already open activates its tab.
Main remembers each file's data source and namespace in `<userData>/fileAttachments.json`, with the
last 10 files opened or saved, which **File → Recent Files** and **Recent Files…** list.

A file console autosaves 500 ms after typing pauses, when the window loses focus, before its tab
closes and before quit (decision 089); the tab shows a dot while its text differs from the file.
An autosave skips a file changed on disk and shows the changed-on-disk banner instead; closing or
quitting asks **Save**, **Don't Save** or **Cancel** only for such a file or after a failed write.
**Save** (`⌘S`) writes a file console now and, on a scratch console, asks for a path like
**Save As…** (`⌘⇧S`), which writes any console to a chosen path; a scratch console becomes a file
console there. **Rename File…** renames a
scratch console's file in the profile, under the name pattern, or the file on disk in its folder.
Removing a data source leaves its file consoles open, detached.

Files are read as strict UTF-8: a BOM is stripped and never written back, and a file that is not
UTF-8 is refused with the offset of its first bad byte. Line endings are kept: a file whose first
line ends in CRLF is written back with CRLF. A file over 32 MiB (`SQL_FILE_EDITOR_MAX_BYTES`) does
not open in the editor; the error points to Run SQL Script. Saves write beside the file and rename
over it, keeping its permissions.

When the window gains focus, main stats the open files. A clean file console whose file changed
reloads; a dirty one shows a banner, **The file changed on disk**, with **Reload** and **Keep
mine**; a deleted file shows **The file was deleted on disk**, and Save writes it again.

### Run SQL Script

**Run SQL Script…**, on a data source or a schema or database in the Database tool window, runs
one or more files without opening them (decision 081). The engine streams each file in 64 KiB
chunks through a strict UTF-8 decoder and the plugin's `splitStream`, on a session of its own in
auto-commit, after the namespace switch statement when run on a namespace. A read-only data source
refuses writes as consoles do. Services shows the run under **SQL Scripts** with the file, the
statements done and the bytes read of the total, and **Cancel**, which cancels the running
statement. A failing statement follows `console.runAllOnError`, sent as `script.run`'s `onError`
(decision 083): `ask` sets the task's `question` and the Services line offers **Skip**, **Skip
All**, **Stop** and **Retry** (`script.answer`); `continue` counts it in `failed` and goes on;
`stop`, and any error but `statementFailed` or `statementTimedOut`, ends the task `failed`. A run
that went past failures ends `done, 2 failed`. A failure names the file, the statement's line and
column and `at`, where in it the database says it failed. **Go to statement** opens the file as a
file console, underlines every failure kept for that file whose statement is still where it ran,
and puts the caret on the chosen one's mark, or selects its statement when it has none. A failure
inside an open transaction says in its hint that PostgreSQL refuses every later statement until
the transaction ends.

## Command consoles

A datasource whose plugin declares `commands` (decision 112) opens the same console with the
plugin's `commandLanguage` instead of SQL: the manifest's `highlight` names a stream highlighter
(`redis`), the editor's accessible name stays `SQL console`, and run scopes, history, Output,
timeouts, Cancel and reconnects behave as for SQL. Redis takes one command per line with
`redis-cli` quoting (`"…"` with backslash escapes, `'…'`) and `#` comments; ⌘↩ runs the line at
the caret or the selected lines, ⇧⌘↩ every line. A scalar reply goes to Output as
`HGET user:42:profile name → "Ann" · 0.4 ms`; an array opens a result tab `#`, `value`, a map
`key`, `value`, a `WITHSCORES` reply `member`, `score`, and a nested element is a `json` value.

Decision 119 (plan 060) amends this for key-value datasources. A bulk-string reply, or nil from a
command that reads one key (`CommandReply.read`), also opens a one-row result tab with a `value`
column, which the engine builds from the reply and holds like any result; its Output line stays.
Status, integer, double, boolean and error replies stay in Output, whose line carries **Show as
Result** (`console.showReply`) to open the same one-row tab. When a command reads exactly one key
(its command-table flags include `readonly` and it names one key), the plugin reports
`ExecuteResult.source` `{ database, key, type, whole }`, from one `TYPE` round trip; `whole` holds
for `GET`, `HGETALL`, `SMEMBERS`, `LRANGE k 0 -1`, `ZRANGE k 0 -1 [WITHSCORES]` and `XRANGE k - +`.
A whole-key reply uses the key tab's columns (hash `field`, `value`; list `#` from 0, `value`; set
`member`; sorted set `member`, `score`) and whole bytes. A sourced result's toolbar and Output line
show **Open Key** (`key.openFromResult`, ⌘B in the grid), which opens the key tab. Its value panel
has the key tab's Format picker, Auto first, remembered per key pattern in `layout.valueFormats`
(per result tab without a source; `key.resultValueFormat` cycles it).

A whole string, hash, list, set or scored sorted set result on a writable datasource is editable:
`result.editable` answers identity `[]` with the `key`, the edit buffer becomes `KeyChange`s as in
the key tab, Preview Pending Changes shows `keyspace.preview`, and Submit runs `keyspace.apply`
guarded (one `MULTI`, `conflict` when the key changed since the read) and then runs the command
again. A conflict keeps the edits and points to Refresh or Open Key, which can overwrite. Other
results are read-only with the reason: not one whole key, a sorted set read without its scores, a
stream or module type (edit it in its key tab), or a read-only datasource.
`SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE` and `MONITOR` are refused (live feeds are out of scope),
as are `HELLO`, `RESET` and `QUIT`; `SELECT` sets the console's database in standalone mode and is
refused in a cluster.

Completion offers commands with their group, syntax, summary and `since` from `COMMAND DOCS`
(a committed 7.4 snapshot before 7.0, limited to the commands and arguments the server has), subcommands, the argument
keywords still unused, and key names from `SCAN 0 MATCH <prefix>* COUNT 200` (at most 50, each
with its type); signature help shows the argument grammar. `classify` marks `FLUSHALL`,
`FLUSHDB`, `DEL`/`UNLINK` of several keys, `SHUTDOWN`, `CONFIG SET` and the other server-wide
changes destructive, and `FLUSHALL`/`FLUSHDB` ask for the datasource's name typed in. Inspections
underline `KEYS`, `HGETALL`, `SMEMBERS`, `LRANGE 0 -1`, `ZRANGE 0 -1`, `SORT` and `XRANGE` without
`COUNT` as costly, with fixes such as "Use SCAN"; nothing blocks the run. A read-only datasource
refuses every command whose flags include `write`, and server-changing admin commands.

On a `nodes` datasource (decision 114) the console toolbar shows **Run on** when there is more
than one node: Auto (by the first key's slot), All primaries (one result led by a `node` column)
or one node. In a cluster `DBSIZE`, `INFO`, `SCAN`, `KEYS`, `FLUSHDB`, `SLOWLOG GET`,
`CLIENT LIST`, `CONFIG GET` and `MEMORY STATS` run on every primary under Auto. A `CROSSSLOT`
error carries the hint to wrap the common part of the keys in `{…}`. Cancel unblocks a blocking
command from a second connection; its tooltip reads "Cancel stops blocking commands only".

## Table data editor

Plan 008, decision 026. F4 on a table or view in the Database tool window, double-click or Enter on
its node, Search Everywhere's Tables tab, or `table.open` opens a table tab labelled `orders [pg]`;
opening a table already open activates its tab. Each table tab has an engine session of its own,
closed with the tab. The layout remembers open table tabs (`openTables`: datasource id, path,
relation, which is active); they reopen disconnected and Reload connects.

`table.query` builds `SELECT * FROM <qualifiedName> [WHERE …] [ORDER BY …]` with the two bars'
text verbatim (trimmed, a trailing `;` dropped) and pages like any statement (decision 025). It
answers the executed statement, the SQL, the catalog's columns and foreign keys for the relation,
the foreign keys of described namespaces that reference it, and `editable`:

| `editable`                      | When                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `{ identity: ["id"] }`          | The primary key, else the first unique key whose columns are all `NOT NULL`         |
| `{ readOnly: "<reason>" }`      | A view or materialized view, no such key, a read-only datasource, no `transactions` |
| `{ readOnly: "…out of date…" }` | The result's columns no longer match the cached catalog; Synchronize and Reload     |

A refused WHERE or ORDER BY shows the database's message under the bars, marks the non-blank bar red
and keeps the previous rows. Enter in a bar applies both, Esc reverts both to the applied text. A
header click asks `table.orderBy` for the plugin-quoted clause, writes it into the ORDER BY bar and
reads again; local sort is refused on a table result. Filter by This Value ANDs a
`table.condition` (`= literal`, `IN (…)`, `IS NULL`) into the WHERE bar. Count Rows runs
`SELECT COUNT(*)` with the applied WHERE on a session of its own, so the open cursor survives.

Pending changes live in the renderer (`model/editBuffer.ts`): cell inputs (`text`, `null`,
`default`) per held row, inserted rows after the held rows, and deleted rows. Submit sends them as
`RowEdit[]`; the engine generates literal SQL with the plugin's `language` in the order deletes,
updates, inserts. An UPDATE or DELETE is keyed by the identity columns; an INSERT lists only
non-default columns, and one with none left uses `language.emptyInsert(table)`. Setting a column to
default uses `language.updateDefault(columnDefault)` (`DEFAULT`, or SQLite's default expression).
`edits.submit` closes the table's cursor, runs every statement in one transaction, requires each
UPDATE and DELETE to affect exactly one row, commits and returns to auto; any failure rolls back and
answers `editRejected` naming the statement, and the buffer stays. After a commit the editor reads
the rows again with the same bars. Read-only tables refuse edits.

Typed cells (plan 043). A `boolean` cell edits in a true/false/NULL dropdown, and Space
(`table.toggleBoolean`) flips the selected boolean cells; the input is `{ kind: "boolean" }`, which
the plugin writes as its boolean literal. MySQL reports `BOOLEAN` as `tinyint`, so its cells stay
numbers. A `date`, `time` or `timestamp`/`datetime` cell keeps the text field and adds a calendar
button opening the app's own picker (plan 111): a month grid for a date, hour, minute and second
fields for a time, both for a timestamp, and a Today or Now button. Every pick is written into the
field at once in the cell's shape (its separator, fraction and zone kept; Now drops the fraction).
A date closes on the day picked; the others close on Enter, Escape or a click outside, which commits
the edit as leaving the field does. A binary cell takes no typed text: Load File into Cell stages the file in the
engine (`result.loadBytes`) and the buffer holds `{ kind: "bytes", id, length, preview }`; Preview
shows the literal clipped with its `/* 32 of N bytes */` comment and Submit writes every byte.

| Action                  | Chord     | Region             |
| ----------------------- | --------- | ------------------ |
| Open Data               | F4        | Database           |
| Reload                  | ⌘R        | table editor       |
| Edit Cell               | ↵, F2     | grid               |
| Set NULL / Set DEFAULT  | ⌥⌘N / ⌥⌘D | grid               |
| Toggle Boolean          | Space     | grid               |
| Transpose               | ⌥⌘T       | grid               |
| Add Row                 | ⌘N        | table editor, grid |
| Duplicate Row           | ⌘D        | grid               |
| Delete Rows             | ⌘⌫        | grid               |
| Revert Selected         | ⌥⌘Z       | grid               |
| Preview Pending Changes | ⇧⌘P       | table editor, grid |
| Submit                  | ⌘↵        | table editor, grid |
| Apply Value             | ⌘↵        | value panel        |
| Go to Referenced Row    | ⌘B        | grid               |

Table-only actions apply only while a table tab is active (`Action.tabKind`); the editing actions
also act on an editable console result. The keymap counts two chords as a clash only when their
regions and tab kinds overlap, or neither preempts the other: Submit and Apply Value list Run in
`Action.preempts`, so ⌘↵ in a grid with pending edits submits and otherwise runs (decision 057). Inside a text field the field's own editing chords (⌘Z, ⌘A, ⌘C, ⌘X, ⌘V, ⌘⌫)
stay the field's. Go to Referenced Row opens the foreign key's target filtered to the focused row's
values; Show Referencing Rows… lists the foreign keys pointing at this table and opens the chosen
one filtered to the selected row. Reload, a filter or sort change, Rerun, closing the tab,
disconnecting and quitting with pending changes ask Submit, Discard or Cancel. A connection that
closes on its own discards pending changes with a notice. The value panel edits text and JSON
cells; ⌘↵ writes the buffer. There is no manual transaction mode in the editor: `Tx: Auto`.

## Import

Plan 021, decisions 046 and 047. **Import Data from File…** on a table and **Import Data into New
Table…** on a schema or database read a CSV or TSV file into it as a background task of the engine,
beside exports. Both need `bulkInsert` and a writable data source; an in-memory SQLite database is
refused, because the import's own session would see another database.

- Reading. The engine streams the file in 64 KiB chunks through `core/import/` and never holds it
  whole: a decoder (UTF-8 with or without its BOM, UTF-16 LE or BE by BOM, Windows-1252; Detect
  sniffs the BOM) and an RFC 4180 reader with a one-character delimiter (`,` `;` tab `|`), a quote
  (`"`, `'` or none) escaped by doubling or by a backslash, CR, LF or CRLF anywhere, quoted
  newlines, a header row, Trim spaces and a NULL text. An unquoted field equal to the NULL text
  (empty by default) is `NULL`; a quoted `""` is the empty string. The TSV preset is the exporter's
  TSV: tab, no quote, backslash escapes. A field past 16 MiB fails the file (an unterminated
  quote), a row with the wrong number of fields is a bad row.
- Dialog. The preview shows the first 100 rows with each column's inferred kind (from the first
  1,000: `integer`, `bigint`, `decimal`, `double`, `boolean`, `date`, `timestamp` or `text`) and the
  file's encoding and size, reloading 250 ms after an option changes. Into a table, each column
  takes the field of the same name (by position without a header) and can be remapped or skipped.
  Into a new table, the name follows the file, each field can be renamed, retyped (the plugin's
  `importType`) or left out, and the plugin's `createTable` statement is shown before it runs.
- Writing. The import opens a writable session of its own, with TCP keepalive, in manual mode, and
  writes batches of 1,000 rows or 1 MiB through `insertRows`. **All or nothing** (the default)
  commits once at the end; **Commit every N rows** (10,000) commits as it goes. A new table is
  created in its own statement first and stays, empty or partial, when the import fails.
- Bad rows. **Stop at the first** (the default) fails the task naming the row and line. **Skip up
  to N** retries a refused batch row by row and writes each refused or malformed row with
  `rejected_line` and `rejected_reason` to `<file>.rejected.csv`; one more than N fails the task.
  The rejected file is cut back to the last commit when the task fails, so it matches the table.
- Failure. Cancel, a lost link, a refused row under Stop and a stall longer than Settings' Transfer
  stall timeout roll back what was not committed and say what was kept: `Nothing was imported: the
transaction was rolled back.` or `10,000 rows are committed; resume from row 10,001.` When the
  link dies during a COMMIT the task cannot know, and says the last commit's rows may or may not be
  there. **Resume** starts a new task from the first uncommitted row, appending to the rejected
  file; with nothing committed it is **Retry**, from row 1.

The Services tool window lists imports under **Imports** with the file, table, state, rows, bytes
read of the file's size, rejected rows and time, and **Cancel**, **Resume** or **Retry** and
**Reveal Rejected Rows**; the status bar shows `Importing N · P%`. A failed import also opens a
notice. When an import ends the engine's catalog cache and the explorer synchronize the schema.
The log records `import finished`, `cancelled` or `failed` with counts and timings, never the file,
the table or a value.

## Completion and navigation

Plan 009, decision 028. Completion and Go to Declaration run in the engine against the catalog
cache; the renderer sends text and a caret and never parses SQL. `SqlLanguage` has
`complete(request, catalog)` and `resolve(request, catalog)`; the built-ins spread
`sqlCompleter(options)` from `@table-craft/plugin-api/sql`, which a third-party plugin may use too:

| Plugin     | `identifierFolding` | `plainIdentifier`           | Quotes         | Extra keywords / functions                                    |
| ---------- | ------------------- | --------------------------- | -------------- | ------------------------------------------------------------- |
| PostgreSQL | `lower`             | `^[a-z_][a-z0-9_$]*$`       | `"Line Items"` | `ILIKE`, `LATERAL`, `RETURNING`; `array_agg`, `string_agg`, … |
| MySQL      | `none`              | `^[A-Za-z_][A-Za-z0-9_$]*$` | `` `x` ``      | `STRAIGHT_JOIN`, `REPLACE`; the full built-in list (below)    |
| SQLite     | `none`              | `^[A-Za-z_][A-Za-z0-9_$]*$` | `"x"`          | `GLOB`, `PRAGMA`; `datetime`, `json_extract`, …               |

`scopeAt` reads the statement around the caret (cut at the lexer's `;` delimiters) into the clause
the caret is in, any `x.` qualifier before it, and the sources in scope: FROM and JOIN relations with
their aliases, comma joins, CTEs (columns from their column list, else their select list), derived
tables with an alias, `UPDATE t`, `INSERT INTO t (…)` and `DELETE FROM t`. A source that cannot be
resolved is ignored. Unqualified names resolve against the current namespace (see Current namespace).

| Caret                                                   | Offers                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| After FROM, JOIN, UPDATE, INTO                          | CTEs, relations of the current namespace in catalog order, namespaces               |
| After JOIN                                              | also join items first: `customers c ON c.id = o.customer_id`                        |
| `x.`                                                    | columns of alias, relation or CTE `x`; relations of namespace `x`                   |
| Select list, WHERE, ON, GROUP BY, ORDER BY, HAVING, SET | in-scope columns (`o.id` when two sources share `id`), aliases, functions, keywords |
| `INSERT INTO t (`                                       | the columns of `t`                                                                  |
| Anywhere else                                           | keywords                                                                            |

A join item follows a foreign key from or to an in-scope relation, outgoing first. Its alias is the
initials of the relation's words (`Line Items` → `li`), suffixed with a digit when taken or a
keyword; a target in another namespace is qualified (`archive.old_orders oo ON …`). A name is quoted
only when it fails `plainIdentifier` or is a keyword; a prefix starting with a quote keeps the
labels quoted. Items are `{ label, kind, detail, apply, boost, info, caret }`; `detail` is a
column's type or a relation's namespace, the foreign key's name for a join, or a function's first
overload (`(date, format) → string`). The engine orders them (join 50, column
40, CTE 35, table and view 30, alias 20, namespace 10, function 0, keyword −10) and the popup keeps
that order between equal fuzzy scores. `validFor` is `^[A-Za-z0-9_$]*$` unless the prefix is quoted.

The engine answers from `CatalogCache` through `core/catalog/completionCatalog.ts`. A namespace not
yet described is described on demand, waiting at most `COMPLETION_DESCRIBE_DEADLINE_MS = 1_500`;
past that the answer uses what is cached and the describe still lands in the cache. Completion runs
on the introspection session, never on a console's.

The console asks while connected: `⌃Space` at once, typing after a word character, `.` or a quote
after `COMPLETION_TYPING_DELAY_MS = 80`; an answer overtaken by a later request is dropped. A
console whose datasource is not connected offers `lang-sql`'s keywords and starts no engine. The
table editor's WHERE and ORDER BY bars complete with `scope: { path, relation }`: the bar's text is
read as the body of a WHERE on that relation. While the popup is open Enter accepts and Esc closes
it; Tab accepts too and also overwrites the rest of the identifier right of the caret, in one undo
step (decision 059). With no popup, Tab indents in the console and moves focus in a bar.

### Functions and parameter hints

Plan 052, decisions 097 and 098. `CompleterOptions.functions` takes plain names or `FunctionSpec`s
(`{ name, signatures: { parameters: { name, optional?, variadic? }[], returns }[], summary,
category, available? }`) from `@table-craft/plugin-api/sql`. A spec's item is the lower-case name
with `detail` its first overload, `info` every overload and the summary (the popup's side panel),
`apply` `name()` and `caret` the offset inside the parentheses, or after them when no overload takes
an argument. A function spelled like a keyword (`IF`, `LEFT`, `REPLACE`, `VALUES`) is offered once,
as a function, where an expression goes; keyword positions keep the keyword.

`available` is a `ServerRange`: per flavour, space-separated comparators on a dotted version
(`{ mysql: "<8.0", tidb: false }`); a flavour it does not name gets the function in every version.
The catalog carries `server: { version }`, the session's `serverVersion`, and the plugin's
`CompleterOptions.server` reads it into `{ flavour, version }`; an unknown or unread version gets
the union. The MySQL plugin ships its lists in `plugins/mysql/src/functions/` by category, one spec
per name, written for this project with the manuals they follow named in each file's header;
`serverIdentity` reads `8.4.0` as MySQL 8.4.0 and `5.7.25-TiDB-v4.0.14` as TiDB 4.0.14. Functions
the TiDB v4.0 manual leaves out but its current manual lists are offered from TiDB 5.0
(`TIDB_AFTER_4`). PostgreSQL and SQLite wrap their short lists as specs; their full lists are a
later plan.

`signatureAt(request, catalog)` finds the innermost unclosed call before the caret in the
statement's tokens, so commas in strings, comments and quoted names never count, and grouping
parentheses are looked through. It answers `{ name, summary, signatures, argument, from, to }`, or
null in a literal, outside a call, inside a subquery, or when the name before `(` is not an
available function (`IN (`, `VALUES (` after a table, `CREATE TABLE t (`). The engine method is
`completion.signature`. The console and the table editor's bars ask when `(` or `,` is typed and
on every edit or caret move while the hint shows; it sits above the call with each overload on a
line and the parameter at the caret bold, an overload the call has outgrown dimmed, and the summary
below. It closes when the caret leaves the call, on Escape (after the completion popup's) and on
blur. Parameter Info (`⌘P`) asks at once.

### Current namespace

Plan 022, decision 048. Unqualified names complete and resolve against the first of:

1. The script: the nearest statement before the caret's statement that switches namespace, run or
   not; its first target naming an existing namespace: a top-level one for `USE`, a schema for a
   search path. A target naming none,
   `DEFAULT` and `RESET` fall through. The WHERE and ORDER BY bars skip this step.
2. The console: `current` on `completion.complete` and `navigation.resolve`, the namespace the
   console's session last reported.
3. The catalog: the namespace the introspection session flags `current`.

| Plugin     | Switching statements (`namespaceStatements`)                                                   | `Session.currentNamespace()`                  |
| ---------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| PostgreSQL | `SET [SESSION \| LOCAL] search_path {TO \| =} …`, `SET SCHEMA 'x'`, `RESET search_path \| ALL` | `[current_database(), current_schema()]`      |
| MySQL      | `USE db`                                                                                       | `[DATABASE()]`, null before a database is set |
| SQLite     | none                                                                                           | not declared                                  |

`classify` marks a switching statement `setsNamespace`. With `currentNamespace` declared, the engine
reads the session's namespace when it opens, after a statement that sets the namespace or a
transaction statement succeeds, and after `transaction.setMode`, `commit` and `rollback`; the reply
carries `namespace`, absent when nothing was read or the read failed. A failed statement changes
nothing; a reconnect starts from the new session's read. `null` (a `search_path` naming no
existing schema) is unknown and falls through to the catalog.

The console toolbar shows the namespace after the datasource's name, the database or schema itself
with the full dotted path as its tooltip, hidden while unknown.

`navigation.resolve` answers what the name under the caret declares: `{ kind: "alias" | "cte",
from, to }` (the `orders o` span, or the CTE's name), `{ kind: "relation", path, relation }`,
`{ kind: "column", path, relation, column }`, or `null`.

| Action id                | Title             | macOS | Windows / Linux | Region         |
| ------------------------ | ----------------- | ----- | --------------- | -------------- |
| `editor.goToDeclaration` | Go to Declaration | `⌘B`  | `Ctrl+B`        | console editor |
| `editor.openData`        | Open Data         | `F4`  | `F4`            | console editor |

Go to Declaration on an alias or CTE moves the caret to its declaration and flashes it; on a
relation it opens the relation's DDL tab when the plugin declares `ddl` (DDL and SQL generation);
on a column, or a relation without `ddl`, it reveals the node in the Database tool window, expanding
and describing the way there, and focuses the tree. Open Data opens the relation under the caret,
through an alias, in a table tab. Both connect a disconnected console's datasource, being explicit
commands.

## DDL and SQL generation

Plan 010, decision 029. A relation's definition comes from the database, and the statements built
around it come from the plugin's language over the cached catalog.

`catalog.definition { path, name }` runs `Introspector.definition` on the introspection session and
is never cached. Each statement ends in `;`, separated from the next by a blank line. An unknown
relation answers `definitionNotFound`, whose hint says Synchronize.

| Plugin     | Definition                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | assembled: `CREATE TABLE` with `format_type` types, identity, generated and `pg_get_expr` defaults, then constraints (`pg_get_constraintdef`, p u f c x); `CREATE INDEX` for indexes backing no constraint; `pg_get_viewdef(oid, true)` for views and materialized views; `COMMENT ON` the relation and columns |
| MySQL      | `SHOW CREATE TABLE` or `SHOW CREATE VIEW`, verbatim (`DEFINER`, `AUTO_INCREMENT=` included)                                                                                                                                                                                                                     |
| SQLite     | `sqlite_master.sql` for the relation, then its explicit indexes' and triggers'                                                                                                                                                                                                                                  |

`sql.generate { path, name, statement }` answers `create` with the definition, and `drop`, `select`,
`insert` and `update` with `language.generate(statement, relation, qualifiedName)`, the relation
read from the catalog cache and `qualifiedName` the introspector's. The built-ins spread
`sqlGenerator({ quoteIdentifier, updateDefault, plainIdentifier, keywords })` from
`@table-craft/plugin-api/sql`: one clause per line, columns in table order, column names quoted
only when the completer would quote them.

| Statement | Text for `orders` on PostgreSQL                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------- |
| DROP      | `DROP TABLE "public"."orders";` (`DROP VIEW`, `DROP MATERIALIZED VIEW`); never `CASCADE`                  |
| SELECT    | `SELECT id, customer_id, total, placed_at` / `FROM "public"."orders";`                                    |
| INSERT    | every column but identity ones; each value the column's `updateDefault(default)`, else `NULL`             |
| UPDATE    | `SET` every non-key column `= NULL`, `WHERE` each primary-key column `= NULL` (every column when keyless) |

A generated UPDATE matches no row until edited, since `= NULL` is never true; the INSERT is the
only statement that writes as it stands.

A DDL tab (kind `ddl`, the DDL glyph, titled `orders [pg]`) is one per datasource, path and
relation; opening it again focuses it. Its body is a read-only, highlighted SQL view with a toolbar:
Refresh, Copy, Open in Console. It reads again whenever the renderer's catalog re-describes its
namespace, as after DDL in a console. DDL tabs are not restored on relaunch.

Quick Documentation is a popover (at most 480×360 px, scrolling) anchored at the selected tree row
or at the caret, drawn from the renderer's catalog copy with no request of its own; F1 at a caret
resolves the name with `navigation.resolve` (an alias resolves to its relation) and describes the
namespace if the tree never did. A relation shows its kind, qualified name, comment, columns (name,
type, `NOT NULL`, default, key marks), primary key, foreign keys out (→) and in (←), and indexes; a
column its type and nullability, default, comment and the keys and indexes it is in. `Esc` or a
click outside closes it.

The SQL Generator is a modal on the selected relation: a radio group CREATE / DROP / SELECT /
INSERT / UPDATE (CREATE only with `ddl`; SELECT chosen and focused; arrow keys move), a read-only
preview, and Open in Console or Copy. Every switch sends `sql.generate`.

| Action id           | Title               | macOS | Windows / Linux | Region                   |
| ------------------- | ------------------- | ----- | --------------- | ------------------------ |
| `ddl.open`          | Go to DDL           | `⌘B`  | `Ctrl+B`        | Database tool window     |
| `catalog.quickDoc`  | Quick Documentation | `F1`  | `F1`            | Database, console editor |
| `sql.generator`     | SQL Generator…      | `⌥⌘G` | `Ctrl+Alt+G`    | Database tool window     |
| `ddl.refresh`       | Refresh DDL         |       |                 | DDL tab                  |
| `ddl.copy`          | Copy DDL            |       |                 | DDL tab                  |
| `ddl.openInConsole` | Open DDL in Console |       |                 | DDL tab                  |

Go to DDL and the generator's CREATE need `ddl` (decision 007). The context menu of a relation in
the Database tool window reads Open Data, Go to DDL, Quick Documentation, SQL Generator…, New
Console, then Synchronize and Copy Qualified Name; a column's starts with Quick Documentation.
A writable datasource whose plugin declares `objects` adds Modify Table…, Rename…, Truncate… and
Drop… to a relation's menu, New Table… (and New Schema… or New Database…) to a schema's, and
Rename… and Drop… to a routine's or sequence's, each only where the plugin's object features say
it can (plan 024, decision 052).

## Execute a routine

**Execute Routine…** (`catalog.executeRoutine`) on a routine's context menu, or in Find Action with
a routine selected, needs a plugin that declares `routineCall` (decision 090). Its dialog says where
the routine lives and what it returns, then lists one row per IN, INOUT or VARIADIC parameter with
its name, mode and type, a value field, a NULL toggle and, when it has a default, a DEFAULT toggle
that starts on; OUT parameters are listed as what comes back. The SQL below is the plugin's, asked
for with `routine.call` as the values change:

| Plugin     | Function                                   | Procedure                                                                           |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| PostgreSQL | `SELECT * FROM f(CAST(:a AS numeric), …);` | `CALL p(CAST(:a AS integer), CAST(NULL AS numeric));`, OUT values as the CALL's row |
| MySQL      | `SELECT f(:a) AS f;`                       | `SET @out3 = :c;`, `CALL p(:a, @out2, @out3);`, `SELECT @out2 AS b, @out3 AS c;`    |

Every value is a named placeholder bound by the driver (decision 043), never pasted into the text.
PostgreSQL casts each value to its declared type, except pseudo-types such as `anyelement`, which
picks the overload; a skipped default leaves its argument out and the arguments after it use named
notation (`rate => …`). A marker is the parameter's name, or `:arg<position>` when the name is not
a plain identifier. **Run** (Enter) opens a new console on the routine's datasource and namespace
with the text and runs all of it with the dialog's values, without the parameters prompt and even
with `console.parameters` off; **Open in Console** opens it with the values seeded and runs
nothing. A new console each time, so the user's console keeps its text, transaction and session
variables. Results, OUT values and server messages show in the console's result tabs and Output,
and history records the run with its values. A read-only datasource still offers it, with a warning
that the server refuses a routine that writes. Routine rows in the tree show their signature beside
the name and the result type in their tooltip.

## Query history and Services

Plan 011, decision 030. Main keeps the query history in `<userData>/history.sqlite`, opened with
`node:sqlite` by core's `history/` (`openQueryHistory`): one table `entries` (`id`,
`datasource_id`, `sql`, `started_at`, `duration_ms`, `outcome` success, error or cancelled,
`row_count`, `message`, `source` console or table, `parameters` the bound values as JSON or
`NULL`), `user_version` 2, WAL. A version 1 file gains the `parameters` column in place, its rows
kept (plan 019). A file that does not open as either schema is renamed `history.sqlite.corrupt-<ms>` and a fresh one is created. Each
datasource keeps its newest `HISTORY_LIMIT = 10_000` entries; recording prunes the oldest. Search
answers distinct statement texts, newest first, at most `HISTORY_SEARCH_LIMIT = 200`, each with its
last start, duration, outcome, row count, message and parameters and how many times it ran; the query matches
anywhere in the text, case-insensitively and literally (`%` and `_` are plain characters).
Deleting a datasource clears its history, and its confirmation says so.

The renderer records, fire-and-forget over `history.record`; a failed write is logged and the run
goes on. Recorded: every statement a console runs (Run, Run All, Rerun) when it succeeds, fails or
is cancelled, with the duration of the statement alone, its row count (rows retrieved, else rows
affected) and the error's message. Not recorded: statements a failure skipped, a batch whose
destructive confirmation or Parameters dialog was declined, `Nothing to run`, table loads and counts, and anything on the
`TABLE_CRAFT_DATASOURCE` datasource. A table submit is one entry with source `table` whose text is
its statements, each ending in `;`, one per line; a failed one is recorded with outcome error and
the database's message, its text previewed again from the same edits.

Query History… (`⌥⌘E`) works on the active console's datasource or the selected one in the Database
tool window, whose context menu lists it after New Console. The dialog is a `ListPicker`
(`renderer/ui/ListPicker.tsx`): a search field over the statements, a list showing each one's
outcome dot, first line, `×3` when it ran more than once, rows, duration and time (`13:28:57`
today, else `2026-10-21 13:28`), and the selected statement in full in a read-only SQL view, with
its error message above it. `↑`/`↓` move, Enter or Insert puts the statement at the console's
caret, replacing the selection as one undo step, and focuses the editor; from the Database tool
window the button reads Open in Console and opens a new console with the text. Copy puts it on the
clipboard; Clear History… asks `Clear the query history of pg? This cannot be undone.` and shows
the emptied list.

Services is a tree (`renderer/model/servicesTree.ts`) with the Database tool window's keyboard
model: each datasource with an open console or table tab and its connection state, under it one
session per tab (console or table glyph, the tab's title, idle, running, waiting for confirmation…,
failed or disconnected, the last run's duration), and under each session its last
`EXECUTIONS_PER_SESSION = 50` executions,
newest first, kept in the renderer for as long as the tab is open (`renderer/state/executions.ts`).
An execution shows its outcome glyph, a spinner and the elapsed time ticking each second while it
runs, its label (a console statement's first line, `Load rows`, `Count rows`, `Submit 2
statements`), rows (updated when Fetch All reads the rest), duration and start time. Everything starts expanded; `No open sessions.` when
there is nothing. Enter or a click on a session or execution activates its tab. A session's context
menu holds Cancel Running Statement while a console runs and Clear Executions; an execution with
SQL holds Copy Execution SQL and Open Execution in Console.

Open Closed Console… (on a saved datasource, from its context menu, the palette or one of its
consoles) lists the datasource's console files that no tab has open, by name, with the selected
one's text in a read-only SQL view. Enter or Open reopens it as a tab under its own name; Delete…
removes the file after a confirmation and shows the list again.

## Sessions

Plan 045, decision 088. A plugin declaring `sessions` lists the server's sessions as `ServerSession`
rows (`plugin-api/src/sessions.ts`): id, the cluster `instance` (TiDB) or null, a `state` of
`active`, `idle`, `idleInTransaction`, `blocked` or `other` and the server's `rawState`, user,
database, client, application, `queryMs` and `transactionMs` measured on the server's clock, the wait,
`blockedBy` ids (null when the dialect or grants cannot tell), the query text, `system` for server
workers, and `cancel` and `terminate`, the exact statements Cancel Query and Terminate Session run,
null where none is safe. `SessionListing.notes` say what the account cannot see and the grant to ask
for.

| Dialect    | Lists                                                                                                                                                      | Cancel / Terminate                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `pg_stat_activity` with `pg_blocking_pids`; without `pg_read_all_stats` other users' rows read `<insufficient privilege>` and a note says so               | `SELECT pg_cancel_backend(pid)` / `SELECT pg_terminate_backend(pid)`; `false` rejects                                                                    |
| MySQL      | `information_schema.PROCESSLIST`, `INNODB_TRX` ages, `performance_schema.data_lock_waits` else `sys.innodb_lock_waits`; notes for `PROCESS` and lock waits | `KILL QUERY id` / `KILL id`                                                                                                                              |
| TiDB       | `information_schema.CLUSTER_PROCESSLIST`, transaction age from `TxnStart`'s TSO; no lock waits                                                             | from 6.1 `KILL TIDB QUERY id` / `KILL TIDB id`; before, no cancel, and terminate runs only on a connection that proved it reached the session's instance |

Stopping runs on a fresh connection. The engine (`sessions.list`, `sessions.cancel`,
`sessions.terminate`) reads on the catalog's introspection session, tags each row whose id is the
`serverSessionId` of one of its own sessions (and, on TiDB before Global Kill, whose instance is its
`serverInstance`) with that engine session id, and refuses to stop
anything on a read-only data source. The request log records `cancelled query of session` and
`terminated session` with the server id and never SQL.

The Sessions tab (`Sessions · <name>`, one per data source) opens from **Show Sessions…** on a data
source, Find Action, or **Show in Sessions** on a Services execution, which selects the console's
own row. Its toolbar holds Refresh, Auto-refresh (every `console.sessionsRefreshSeconds`, default
5), Hide idle, Hide system, Blocked only and a search over id, user, database, client, application
and query. The table shows PID, State, User, Database, Client, Application, Query time, Tx age,
Wait, Blocked by and Query, tinting idle in transaction with `warning` and blocked with `danger`,
and marking the engine's own rows `you`. Below it the selected row's query in a read-only SQL view
and its details, with Open in Console, Explain Plan, Copy SQL, Cancel Query and Terminate Session….
Terminate confirms with the exact statement; a data source coloured red asks for the PID typed in,
and an own row warns that the session is TableCraft's.

## Server tab

A datasource whose plugin declares `serverInfo` (decision 114) offers Server Info
(`server.show`) on its menu. The tab shows the server's sections as cards, Memory, Clients,
Stats (with ops/s and hit ratio), Replication, Persistence, Keyspace, Server, CPU and Cluster,
each with its headline figures and the rest folded, refreshed Off, every 2, 5 or 10 s. In a
cluster a node picker offers Overview (node, role, slots, memory, ops/s per node) and each node.
The Slow log view lists `SLOWLOG GET 128` (every primary in a cluster): time, duration, command,
client and node, with Open in Console. Redis' sessions (Sessions view) come from `CLIENT LIST`
on every primary; Cancel Query sends `CLIENT UNBLOCK <id> ERROR`, Terminate `CLIENT KILL ID <id>`.

## Datasources and secrets

Main owns the datasource list (decision 010) and every secret (decision 020). The renderer reads
and changes them over `ipcRenderer.invoke`; main stays out of the request path.

### Files

`<userData>/datasources.json`, written atomically (a temporary file, then a rename):

```json
{
  "version": 1,
  "datasources": [
    {
      "id": "0b7c…",
      "name": "pg",
      "pluginId": "postgres",
      "folder": "Docker/Main",
      "color": "blue",
      "readOnly": false,
      "comment": "",
      "config": {
        "host": "localhost",
        "port": 5432,
        "database": "table_craft",
        "user": "table_craft",
        "sslMode": "disable"
      },
      "secretModes": { "password": "forever" }
    }
  ]
}
```

`id` is a UUID. `folder` is a `/`-separated path or `null`. `color` is one of `red`, `orange`,
`yellow`, `green`, `blue`, `violet` or `null`; the values are design tokens. `config` holds only
the manifest's non-secret fields; a secret value is never in this file. An older `version` is
migrated on load. A file that is not JSON, fails the schema, or has an unknown version is renamed to
`datasources.json.corrupt-<epoch ms>`, the list starts empty, and the Database tool window shows
the reason once. Two optional keys sit beside `readOnly` (decision 054): `keepAliveSeconds`
(0–7,200; absent means 30, 0 turns keepalive off) and `statementTimeoutSeconds` (0–86,400; absent
follows the `console.statementTimeoutSeconds` setting, 0 waits). The Data Sources dialog shows
them in Advanced, the first for a plugin with `keepAlive`, the second for one with `cancel`. An
imported datasource carries `origin: { app: "datagrip" | "tablepro", id }` (decision 068), the
other app's id for it, so a second import knows it; editing keeps it, and nothing else reads it.

A plugin with `connection.url` (decision 055) gets a URL row at the top of General: a URL pasted
there, or into the host or file field, fills the fields, and its password becomes the password
field's typed value, saved by its mode. The row then shows the URL without the password, notes
"Password from the URL", and lists what was ignored. "Copy as URL" in a datasource's context
menu and the palette writes the saved datasource's URL, never a secret.

`<userData>/secrets.json` is `{ "version": 1, "secrets": { "<datasource id>": { "<field key>":
"<base64 safeStorage ciphertext>" } } }`, holding Forever secrets only.

### SSH tunnel

A datasource whose plugin declares `connection.network` may carry, beside `config` (decision 070):

```json
"ssh": { "enabled": true, "host": "bastion.example.com", "port": 22, "user": "deploy", "auth": "key", "keyPath": "~/.ssh/id_ed25519" }
```

`auth` is `password`, `key` (an OpenSSH or PEM private key; a leading `~` is the home folder) or
`agent` (`SSH_AUTH_SOCK`; on Windows otherwise the OpenSSH agent's pipe `\\.\pipe\openssh-ssh-agent`, not Pageant, whose ssh2 helper `pagent.exe` the bundle cannot carry). The SSH password and the key passphrase are secrets
under `ssh.password` and `ssh.passphrase`, with save modes like any other. Connect asks for
`ssh.password` with password auth and for `ssh.passphrase` only when the key file is encrypted. A
save without `ssh` clears both, and `ssh` is dropped for a plugin without `network`. `enabled:
false` keeps the settings but connects directly.

The Data Sources dialog shows an **SSH/SSL** section between General and Advanced for such a
plugin: _Use SSH tunnel_, SSH host and port (22 when blank), SSH user, Authentication (Password,
Key pair, SSH agent), the private key with Browse…, and the password or passphrase with its save
mode. The fields are disabled while the box is clear; when it is ticked, host, user and, for key
auth, the key file are required. Test Connection shows "SSH: connected to `<host>` as `<user>`"
above the database line when the bastion was reached.

The engine host's connector opens one SSH connection per datasource on the first session and shares
it, counting sessions; the last to close takes it down. The host and port in `config` are where the
bastion forwards to. If the SSH connection drops, every session call fails `sshTunnelLost`; a
console abandons the session and its next statement reconnects through a new tunnel. A forward the
bastion refuses is named in the database hop's `connectionFailed`.

Host keys follow decision 071: `<userData>/ssh_known_hosts.json`
(`{ "version": 1, "hosts": [{ "host", "algorithm", "key", "addedAt" }] }`, host `name` on port 22,
`[name]:port` otherwise) and `~/.ssh/known_hosts`, read only. An unknown key opens "Unknown SSH host
key" (server, key type, `SHA256:` fingerprint; Cancel by default, Trust); a changed key refuses with
both fingerprints and the file.

### SSL certificates

A plugin whose manifest declares `connection.tls` (decision 072) names its SSL fields: `mode`, a
select offering every value in `verifyModes`, and optionally `caFile`, `certFile`, `keyFile` (kind
`file`) and `keyPassphrase` (a secret password). PostgreSQL and MySQL declare `sslMode` (Disable,
Require, Verify CA, Verify full), `sslRootCert`, `sslCert`, `sslKey` and `sslKeyPassphrase`:

```json
"config": { "host": "db.example.com", "sslMode": "verify-full", "sslRootCert": "~/certs/ca.pem" }
```

`config` keeps the paths, never the file contents; the plugin reads them on every connect, with a
leading `~` as the home folder. A file it cannot read fails `connectionFailed` naming the field's
label and the path, as does a key it cannot decrypt; a server certificate the CA does not sign names
the CA file, one issued for another name names the host. Such failures carry the hint "Fix the SSL
settings under SSH/SSL in the data source's properties." instead of the host-and-password one.

| Mode        | Encrypted | Chain checked                        | Host name checked |
| ----------- | --------- | ------------------------------------ | ----------------- |
| Disable     | no        | no                                   | no                |
| Require     | yes       | no                                   | no                |
| Verify CA   | yes       | against the CA file, else the system | no                |
| Verify full | yes       | against the CA file, else the system | yes               |

The dialog shows the fields under an **SSL** heading in the SSH/SSL section, in that order. A CA file
with Disable or Require stays unused and says "Use Verify CA or Verify full to check this CA file."
The passphrase is kept only while a client key is named, and connect asks for it only when the key
file is encrypted (`ENCRYPTED PRIVATE KEY` or a PEM `Proc-Type: 4,ENCRYPTED`). Test Connection adds
"SSL: `<protocol>` · `<cipher>`", or "SSL: not encrypted", for a plugin whose session reports `tls`.

Through an SSH tunnel the plugin connects to `127.0.0.1`, so the connector passes the configured
host as `ConnectOptions.serverName` (decision 073), and Verify full checks the certificate against
that name. URLs carry the paths: `sslmode`, `sslrootcert`, `sslcert`, `sslkey` for PostgreSQL;
`ssl-mode` (`VERIFY_CA`, `VERIFY_IDENTITY`), `ssl-ca`, `ssl-cert`, `ssl-key` for MySQL. A blank
path is left out of a copied URL.

### Save modes

| Mode          | Kept                                    | Connect                                       |
| ------------- | --------------------------------------- | --------------------------------------------- |
| Forever       | `safeStorage`-encrypted in secrets.json | uses it; asks when it no longer decrypts      |
| Until restart | main's memory                           | uses it; asks after a restart                 |
| Never         | not kept                                | asks every time; the value goes to the engine |

A new secret defaults to Forever when `safeStorage` can encrypt, else Until restart. When it cannot,
Forever is disabled in the dialog with the reason, and main refuses it; there is no plaintext
fallback. A secret input never shows the stored value: blank keeps it, Clear removes it. Changing a
mode moves the stored value. Deleting a datasource clears its secrets.

### IPC

Each invoke answers `{ ok: true, value }` or `{ ok: false, error: { message, hint } }`, and each
request is parsed with Zod in main.

| Channel (`table-craft:` …) | Request                             | Value                                                                                   |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `datasources.list`         | none                                | `{ datasources, warning, encryption: { available, reason } }`                           |
| `datasources.save`         | `{ datasource, secrets }`           | the saved datasource                                                                    |
| `datasources.delete`       | `id`                                | `null`; stops its engine, clears its secrets, consoles and history                      |
| `datasources.test`         | `{ datasource, secrets }`           | the probe result; stored secrets are merged in main                                     |
| `datasources.parse-url`    | `pluginId`, `url`                   | `{ values, secrets, ignored }`; nothing is saved                                        |
| `datasources.url`          | `id`                                | the saved datasource's URL, without secrets                                             |
| `plugins.list`             | none                                | `{ id, name, unavailableReason, capabilities, fields, url, network, tls, highlight }[]` |
| `ssh.answer-host-key`      | `requestId`, `trust`                | `null`; answers an `ssh.host-key-prompt` (decision 071)                                 |
| `consoles.list`            | `datasourceId`                      | the saved console names, sorted                                                         |
| `consoles.read`            | `datasourceId`, `name`              | the text, or `null` when there is no file                                               |
| `consoles.write`           | `datasourceId`, `name`, `text`      | `null`; written atomically                                                              |
| `consoles.delete`          | `datasourceId`, `name`              | `null`; deleting a missing file is not an error                                         |
| `consoles.rename`          | `datasourceId`, `from`, `to`        | `null`; refuses a name taken in the directory                                           |
| `sql-files.choose`         | `title`                             | the `.sql` paths chosen, several at once, or none                                       |
| `sql-files.open`           | `path`                              | `{ path, sql, lineEnding, modifiedAt, attachment }`; marks it recent                    |
| `sql-files.read`           | `path`                              | the same, leaving the recent files alone                                                |
| `sql-files.write`          | `path`, `sql`, `lineEnding`         | `{ modifiedAt }`; written atomically, marks it recent                                   |
| `sql-files.rename`         | `path`, `name`                      | `{ path }`; renamed in its folder                                                       |
| `sql-files.stat`           | `paths`                             | each file's modification time, or `null` when it is gone                                |
| `sql-files.attach`         | `path`, `datasourceId`, `namespace` | `null`; remembers the file's data source and namespace                                  |
| `sql-files.recent`         | none                                | the recent files, most recent first                                                     |
| `history.record`           | a `HistoryEntry`                    | `null`                                                                                  |
| `history.search`           | `datasourceId`, `query`             | `HistoryStatement[]`, newest first                                                      |
| `history.clear`            | `datasourceId`                      | `null`                                                                                  |
| `window.answer-close`      | `proceed`                           | `null`; closes the window, or finishes the quit (decision 024)                          |
| `engine.connect`           | `datasourceId`, typed `secrets?`    | `connected`, `needsSecrets { keys }` or `failed`                                        |
| `engine.disconnect`        | `datasourceId`                      | `null` once the engine has exited                                                       |
| `dialog.choose-file`       | `title`                             | a path, or `null`                                                                       |
| `dialog.open-any-file`     | `title`                             | an existing file's path of any type, or `null`; Load File into Cell (plan 043)          |
| `settings.read`            | none                                | `{ settings, themes, warning }`; see Settings and appearance                            |
| `settings.write`           | the whole settings document         | `null`; saved, then broadcast as `settings.changed`                                     |
| `themes.reload`            | none                                | `null`; rereads `<userData>/themes/`, then broadcasts                                   |
| `themes.open-folder`       | none                                | `null`; creates the folder if missing and opens it                                      |
| `import.scan`              | none                                | `ImportSource[]`: per app, found, count, where it looked, password store                |
| `import.preview`           | `{ source }` or a file + phrase     | `ready { previewId, rows }`, `needsPassphrase` or `wrongPassphrase`                     |
| `import.run`               | `previewId`, `keys`, options        | `{ imported, withPasswords, skipped, ids, cancelled, keychainDenied }`                  |
| `import.cancel`            | none                                | `null`; the run stops before its next item                                              |

Console ids and names must match `CONSOLE_NAME_PATTERN = /^[\w.-]{1,64}$/` and not be dots alone,
so no request leaves `<userData>/consoles/`. A listed datasource carries `storedSecrets` (the keys
main can use without asking), never values.
`secrets` in a save or test maps each secret key to `keep`, `set { value }` or `clear`. Main
broadcasts `datasources.changed` with the new list after every save or delete, and
`engine.exited { datasourceId, code, clean }` when an engine ends, and sends
`window.close-requested` when the window is asked to close, `ssh.host-key-prompt { requestId,
offer }` to the focused window when an engine meets an unknown host key, and `sql-files.open-recent`
with the path chosen in File → Recent Files. On `connected` the port arrives
as `table-craft:engine-port` with the datasource id, relayed by preload as a window message; a
window holds one port per connected datasource.

### Importing from DataGrip and TablePro

Main reads the other apps' files read-only (decision 067; `main/import/`) and keeps every password
it reads; a preview row says only where a password would come from (`keychain`, `found`, `inFile`,
`locked`, `askOnConnect`, `notSaved`, `notNeeded`). The preview stays in main under its
`previewId` until the run.

- **DataGrip**: the newest `DataGrip<version>` config directory, its global
  `options/dataSources.xml`, and each project's `.idea/dataSources.xml` with
  `dataSources.local.xml` winning per field. Projects come from `projects/` and
  `options/recentProjects.xml`; `$USER_HOME$`, `$PROJECT_DIR$` and the path macros expand. A
  `group-name` becomes the folder, else the project name. Passwords live where
  `options/security.xml` says: the native store (macOS Keychain through `/usr/bin/security`, the
  Secret Service through `secret-tool`), read only during the run and only when Import passwords is
  on, one lookup per item, stopping at the first denial; or the KeePass `c.kdbx`, opened at
  preview with the built-in main key in `c.pwd`.
- **TablePro**: `connections.json` in its Application Support folder and its groups from the
  `com.TablePro` defaults, without passwords; or a `.tablepro` export, plain or encrypted with a
  passphrase, with them.

A connection maps by its URL scheme to a plugin's `connection.url.schemes`; one no plugin claims is
listed as not supported. An SSH tunnel and an SSL mode TableCraft lacks become warnings; the CA,
client certificate and client key paths fill the plugin's `connection.tls` fields, and Verify CA
maps to `verify-ca`. A connection whose origin, or whose plugin, host, port, database, user and path, matches
an existing datasource starts unticked; importing it adds `<name> (2)`. `import.run` saves all of
them in one write and sends `import.progress { done, total, message }` as it goes. The `import`
log child records counts only.

### Database tool window

Datasources sit in folders, folders first, each level sorted by name. A node shows the plugin
icon, the name, the colour swatch, a lock when read-only, and its state: disconnected,
connecting, connected, failed with the error, or "failed: engine exited". A toolbar carries New
Data Source, Properties, Synchronize, Connect, Disconnect, New Console and Collapse All; each node's
context menu carries the datasource actions. Enter or a double-click opens a console. With no
datasources the window shows "No data sources." and a New Data Source button.

### Database explorer

A datasource whose plugin declares `schemaTree` expands into its catalog (plan 005,
`datagrip-inventory.md` §3). The tree is one flat, virtualized list built by
`renderer/model/explorerTree.ts` from the datasource list and `renderer/state/catalog.ts`:

| Node                    | Children                                                                 | Shows                                              |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| datasource              | its namespaces, hierarchical by path                                     | as above                                           |
| namespace (database)    | its schemas                                                              | the name                                           |
| namespace (schema)      | groups `tables`, `views`, `materialized views`, `routines`, `sequences`  | the name; a spinner while synchronizing            |
| group                   | its objects; a group exists only when non-empty                          | `tables 3`                                         |
| table, view             | `columns N`, `keys`, `foreign keys`, `indexes`, each only when non-empty | the name                                           |
| column                  | none                                                                     | `name  type`, key icon for PK or FK, NOT NULL mark |
| key, foreign key, index | none                                                                     | the name and its columns; `(a) → t(b)`; `unique`   |
| `loading…`, error       | none                                                                     | a spinner; the error's message, hint beside it     |

Expanding a disconnected datasource connects it; whenever a datasource attaches, by the tree or by a
console, its namespaces are listed and the current one is described and expanded. Expanding a
schema describes it once; Synchronize (`⌥⌘Y`) describes the selected namespace again, or relists
namespaces on a datasource node. A namespace that fails to describe turns the danger colour, shows
the error under it, and leaves its siblings alone; Synchronize retries it. Detaching a datasource
for any reason clears its catalog. System namespaces are hidden unless Show System Schemas is on,
which the window's layout remembers.

With the tree focused, typing opens speed search over loaded rows only: matched characters are
marked, the selection jumps to the first match, `↑`/`↓` step between matches and wrap, Enter keeps
the selection, Esc closes; no match turns the field the danger colour. A contiguous run is marked
before a fuzzy match, so `cust` marks `cust` in `customer_totals`. Search Everywhere's `Tables` tab
lists every loaded relation as `orders` with `pg › table_craft › public` beside it; choosing one
runs Select in Database View, which opens the tool window, expands the path and selects it. Copy
Qualified Name puts the plugin's quoting on the clipboard (`catalog.qualifiedName`).

The status bar's `sync` item reads `public synchronized (38 ms) · 2 min ago` for the selected
namespace of the active datasource, else its current one, refreshed every minute
(`SYNC_LABEL_TICK_MS`), or `explorer_restricted failed: …` with the hint when the selected one
failed.

The Data Sources dialog follows DataGrip: the list on the left with add, duplicate and remove; the
form on the right with Name, Folder, Comment, the plugin's General fields, its Advanced fields,
Options (Read-only, Colour) and a save mode beside each secret; Test Connection, then OK, Cancel
and Apply. Test Connection reports "Succeeded · PostgreSQL 17.4 · 38 ms" or the plugin's error and
hint.

### Key browser

A datasource whose plugin declares `keyValue` (decision 113) expands into a key tree instead of
the catalog. Standalone Redis lists its non-empty databases and the configured one (`db0 6 keys`;
Show Empty Databases, `explorer.toggleEmptyDatabases`, lists the rest); a cluster lists one `db0`
and a **Cluster nodes** group (`127.0.0.1:7001 primary 0–5460`, `… replica of …`). Under a
database come a filter row (a `MATCH` glob and a type, rescanned on Enter), folders by the
plugin's delimiter with the count of loaded keys, then keys with their type badge and TTL. A pass
scans `SCAN` batches until 10,000 keys, then shows `Scanned 10,000 of ~48,213 · Load more`. Only
visible keys are described (type and TTL), in batches of 200. Synchronize rescans.

Enter or a double-click opens a key tab: a header with the type badge, the name, the datasource
and database, a TTL counting down, then length, memory, encoding and idle time, each left out when
the server refuses it; a filter bar (`Match` for hash, set and zset, From and To ids for streams);
and the grid: hash `field`, `value` (and `ttl` on 7.4+), list `#`, `value`, set `member`, zset
`#`, `member`, `score`, stream `id` and one column per field. A string fills the tab with a value
editor. RedisJSON and other module types open read-only. The value panel carries a format picker
(Auto, Text, JSON, Hex, Base64, MessagePack, gzip) remembered per key pattern in the layout; Text,
JSON, Hex and Base64 edit the bytes they show. Rerun (⌘R) reloads. A console result that read one
key opens the same tab through Open Key, and a whole-key console result edits through the same
apply path (see Command consoles, decision 119).

Edits use the table editor's buffer and tints: Add Row, Delete Rows, Revert, Preview (the numbered
commands) and Submit, whose footer reads "Submit runs as one MULTI · not undoable" (decision 115).
A guarded Submit that finds the key changed shows a banner with Reload and Overwrite. A key that
disappears shows "`user:42:session` no longer exists" with Recreate and Close. Rename (⇧F6),
Delete (⌘⌫) and Copy Qualified Name work on keys; New Key…, Set TTL…, Remove TTL, Delete Keys
Under Folder… (a cancellable Key Deletions task in Services, 500 keys per call) and Go to Key…
have no chord. Search Everywhere has a **Keys** tab over loaded keys. The status bar's datasource
item adds `db0 · 48,213 keys` or `cluster · 3 primaries`.

### Development seam

`TABLE_CRAFT_DATASOURCE`, JSON `{ id, pluginId, config }`, adds one ephemeral datasource at the top
of the list, named by its id, never written to disk, its secrets kept Until restart, and opens a
console on it at launch. A malformed value stops the app naming the variable (decision 018).

## Settings and appearance

Plan 013, decisions 012 and 032. Preferences are `<userData>/settings.json`, owned by main
(`main/settings.ts`), read before the window opens and written atomically:

```json
{
  "version": 1,
  "appearance": {
    "theme": "system",
    "density": "comfortable",
    "systemTitleBar": false,
    "fonts": {
      "ui": { "family": null, "sizePx": 13 },
      "editor": { "family": null, "sizePx": 13 },
      "grid": { "family": null, "sizePx": 12 }
    }
  },
  "editor": {
    "format": {
      "style": "aligned",
      "keywordCase": "upper",
      "indentWidth": 2,
      "linesBetweenStatements": 1,
      "alignAliases": true
    }
  },
  "console": { "parameters": true, "statementTimeoutSeconds": 0, "runAllOnError": "ask" },
  "data": { "nullText": "<null>", "groupDigits": false, "pageRows": 500, "fetchAllCap": 100000 }
}
```

| Field                                  | Values                                                                                        | Default       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| `appearance.theme`                     | `system`, `dark`, `light`, `highContrast`, a ported theme id, `user:<file stem>`              | `system`      |
| `appearance.density`                   | `comfortable`, `compact`                                                                      | `comfortable` |
| `appearance.systemTitleBar`            | boolean; read once when the window is created                                                 | `false`       |
| `appearance.fonts.*`                   | `{ family: string \| null, sizePx: 8–32 }`; `null` is the built-in stack                      | 13, 13, 12    |
| `editor.format.style`                  | `aligned`, `standard`                                                                         | `aligned`     |
| `editor.format.keywordCase`            | `upper`, `lower`, `preserve`                                                                  | `upper`       |
| `editor.format.indentWidth`            | 1–8 spaces                                                                                    | 2             |
| `editor.format.linesBetweenStatements` | 0–5 blank lines                                                                               | 1             |
| `editor.format.alignAliases`           | boolean; line up `AS` in a select list (aligned style)                                        | `true`        |
| `console.parameters`                   | boolean; ask for `:name`, `?` and `$1` values before a run                                    | `true`        |
| `console.statementTimeoutSeconds`      | 0–86,400; a console statement running longer is cancelled; 0 waits; a datasource may override | 0             |
| `console.runAllOnError`                | `ask`, `stop`, `continue`; what a run of several statements, or a script, does on a failure   | `ask`         |
| `data.nullText`                        | 1–16 characters                                                                               | `<null>`      |
| `data.groupDigits`                     | boolean                                                                                       | `false`       |
| `data.pageRows`                        | 10–10,000                                                                                     | 500           |
| `data.fetchAllCap`                     | 1,000–1,000,000, at least `pageRows`                                                          | 100,000       |

Each field is read on its own: a missing or out-of-range one takes its default and the rest stand.
A file that is not JSON, not an object or from a newer version is renamed to
`settings.json.corrupt-<ms>`, the app opens with defaults, and the Database tool window shows the
notice. The defaults, ranges and field reader are one pure module,
`packages/desktop/src/settings/settings.ts`, shared by main and the renderer.

The renderer loads the document before its first render and keeps it in `state/settings.ts`. A
change in the Settings dialog applies at once and is written with `settings.write`; main saves it,
sets `nativeTheme.themeSource` and the window's background to the theme's canvas, and broadcasts
`settings.changed { settings, themes }` to every window. A failed write restores the previous value
and says why in the dialog.

Themes are colour token sets (`packages/desktop/src/appearance/themes.ts`, design-system.md): Dark,
Light, High contrast, 43 themes ported from preman's vendored openchamber palettes, generated and
contrast-audited at build time (decision 064, ids such as `gruvbox-dark`), and Follow system, which picks High contrast when `prefers-contrast: more`
matches, else Dark or Light from `prefers-color-scheme`, and follows both live. A user theme is
`<userData>/themes/<stem>.json`, `{ name, base, colors }` with `base` any bundled theme id and
`colors` any colour tokens, `syntax` and `datasource` as partial objects. Main reads at most 64
files of at most 64 KiB, validates them, and lists each resolved over its base or with its errors;
a broken one (including one whose base is not a bundled theme, named in its error) cannot be
chosen, and a chosen one that is gone or broken falls back to Dark with a notice. Reload Themes
rereads the folder; nothing watches it.

The theme is chosen from a dropdown (decision 065): a filter by name or source over the groups
Follow system, TableCraft, Dark, Light and Your themes. The highlighted theme previews at once in
the renderer only (`previewTheme` in `state/settings.ts`, never written); Enter or a click saves
it, Escape, a click outside or closing the dialog puts the saved one back.

The UI, editor and grid fonts each have a family and a size; the family list comes from
`queryLocalFonts()`, monospace families first for the editor and grid, with a free-text field when
the list is unavailable. Compact density makes rows 20 px instead of 24, the cell padding and
gap 6 px instead of 8, and the main toolbar 32 px instead of 40, which main applies to the native
window controls at once. In the SQL editor `⌘=`, `⌘-` and `⌘0` change the saved editor font size by
1 px and reset it to 13.

NULL text and Group digits change what the grid draws and measures, nothing else (decision 032).
The page size and Fetch All limit travel with each request (see Renderer to engine).

The Settings dialog (`⌘,`; the macOS app menu's Settings…, File → Settings… elsewhere) has four
pages: Appearance (theme, Reload Themes, Open Themes Folder, density, UI font, and under Window,
Use system title bar with "Takes effect after restart." and a Restart Now button, `app.relaunch`,
shown while the choice differs from the running window; it asks to close dirty tabs first, as Quit
does, then relaunches), Editor (editor
font, the zoom chords, and under Running, query parameters and the statement timeout) and Data Editor (grid font, NULL text, Group digits, page size, Fetch All
limit) and Advanced (Debug logging, `log.level`, see App log and diagnostics; under Running, When a
statement fails, `console.runAllOnError`; the Sessions refresh). Each page has
Restore Defaults; a value outside its range is refused inline and not saved.
Keymap editing and date and time formats are not settings in v1.

## App log and diagnostics

Plan 017, decision 038. Main is the only writer of `<userData>/logs/table-craft.log`: one JSON
object per line, `{ ts, level, process, scope, msg, ...fields, err? }`, where `process` is `main`,
`renderer`, `engine:<datasourceId>` or `probe:<datasourceId>` and `err` carries name, message,
code, stack and up to five causes. At 5 MB the file rotates to `table-craft.1.log`, keeping four older files up to `table-craft.4.log`.
Levels are `error`, `warn`, `info` and `debug`; `log.level` (`info` by default, `debug` with
Settings → Advanced → Debug logging) is applied by main at once, so engines and renderers send
every record and main drops what is below the level.

The engine posts `engine.log` messages over its parent port; its stdout and stderr are piped and
logged line by line under scope `stdio`. The renderer batches records for 500 ms or 100 records
and sends them on `log.write`, validated, each capped at 16 KB (a longer one keeps its `msg` and
gains `truncated: true`). A request's id (`requestId`) appears on the renderer's failure and the
engine's record for it, so one id follows a request across processes.

At `info` the log has the launch (versions, platform, locale, packaged, profile folder), plugins
loaded or unavailable, engine hosts started and exited with code and uptime, connects with the
non-secret target fields, each statement's kind, row count, duration and outcome, transactions,
exports, edits, Test Connection, diagnostics exports and every failure with its error chain. At
`debug` it adds one record per engine request with its type and elapsed time. It never holds a
password, a secret, a row value or SQL text: main redacts keys that name a secret, URL userinfo
and every secret value it handed to an engine, in every record from every process. A database's
own error message can still quote a value from the statement.

Help → Show Log opens the Log tool window on the right stripe: the last 2,000 records newest first
with live tail, filters for level, scope and text, Copy on each record and Reveal Log File. An
error notice from a request has Show in Log, which opens the window filtered to that request id
(or the message text when there is none). Help → Reveal Log File shows the file in the file
manager. Help → Export Diagnostics… lists what it will include, asks for a place and writes
`table-craft-diagnostics-<yyyyMMdd-HHmmss>.zip`: `logs/` (every log file), `about.json`
(versions, platform, plugins with version and API version), `settings.json`, `datasources.json`
without credentials and `history.json` (the last 50 runs: datasource, outcome, rows, duration,
time, without SQL or messages). The zip writer is in-house over `node:zlib`.

## In-app update

Plan 020, decisions 044 and 045. The updater lives in main (`main/update/`); the renderer draws
the state main pushes and invokes actions.

**Manifest.** `update-manifest.json` is `{ schema: 1, version, notesUrl, minimumVersion, assets }`
with `assets` keyed `<platform>-<arch>` (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`),
each `{ url, size, sha256 }`. `update-manifest.json.sig` is the base64 Ed25519 signature of the
manifest's bytes. Main fetches both from
`https://github.com/tranphucbol/table-craft/releases/latest/download/` with `net.fetch` and
verifies the signature against `UPDATE_PUBLIC_KEY` (`main/update/manifest.ts`) before parsing.
A manifest is rejected for a bad signature, a schema other than 1, or a malformed field (asset URLs
must be `https:` without credentials, `sha256` 64 hex digits). Versions compare as semver, a
pre-release below its release. `scripts/update-manifest.ts` writes and signs the manifest in the
release job from `TABLE_CRAFT_UPDATE_SIGNING_KEY`, naming assets by `TableCraft-<version>-<arch>`.

**State.** One union, pushed on `table-craft:update.state` and read with `update.state`, every
member carrying `current`:

| Phase         | Carries                            | Button                     |
| ------------- | ---------------------------------- | -------------------------- |
| `idle`        | —                                  | none                       |
| `checking`    | —                                  | none                       |
| `available`   | `release {version, size}`          | Update (accent)            |
| `downloading` | `release`, `received`, `total`     | `NN%`                      |
| `ready`       | `release`                          | Restart to Update (accent) |
| `error`       | `release?`, `message`, `retryable` | Update failed (danger)     |
| `ineligible`  | `release`, `message`               | Update (neutral)           |

The invoke channels are `update.check`, `update.download`, `update.cancel`, `update.install`,
`update.skip`, `update.dismiss` and `update.openNotes`; none takes a URL. The actions
(`renderer/actions/updateActions.ts`) are Check for Updates… (Help menu and Settings → Advanced),
Show Update (the button), Download, Cancel Download, Retry, Restart to Update, Skip This Version,
Later, Dismiss and Release Notes, each available only in the phases where it applies.

**Checks.** With `updates.checkAutomatically` on (the default), a packaged app checks 10 s after
the window first shows and every 24 h. An automatic check that fails on the network, or finds a
manifest of a later schema, stays `idle` and logs a warning; one that finds the skipped version
(`<userData>/update-state.json`) stays `idle`. A manual check reports every outcome; with nothing
newer Help → Check for Updates… says "You're up to date". A development run never checks on its
own and, asked, reports that it cannot replace itself.

**Eligibility.** In order: not packaged; no asset for this platform and architecture; older than
`minimumVersion`; on macOS translocated (`/AppTranslocation/`), on a mounted volume (`/Volumes/`)
or in a folder main cannot write; on Linux not started from an AppImage. An ineligible release is
shown with the reason and Release Notes, which opens the release page.

**Download.** Streamed to a temporary file and hashed as it arrives; progress is pushed at most
every 100 ms and logged at 25, 50 and 75 %. A size or SHA-256 mismatch deletes the file and says
"The download does not match the signed release: SHA-256 …"; an interrupted download deletes it
and offers Retry, which starts over. On macOS the zip is expanded with `ditto -x -k` into
`.table-craft-update-<id>` beside the bundle and must hold exactly one app with its executable.

**Install.** Restart to Update goes through the close guard. At `will-quit` main hands over:
macOS writes a `/bin/sh` script (`main/update/swap.ts`) and starts it detached. The script waits
up to 60 s for the old process, moves the bundle to `<bundle>.update-backup`, moves the staged one
in, restores the backup if the new bundle lacks its executable, strips `com.apple.quarantine`,
removes the backup and staging folder and starts the new executable with the old arguments. Its
output goes to `<userData>/update-swap.log`, which the next launch logs under scope `update` and
deletes. Windows runs the downloaded installer with `/S --updated --force-run`; Linux renames the
downloaded AppImage over `$APPIMAGE` and relaunches. Quitting with a staged or partial update and
no install discards it. A second launch while one instance runs focuses the first window
(`requestSingleInstanceLock`).

**Logging.** Scope `update`, with `current` and a `step` (`check`, `download`, `install`, `swap`);
URLs are logged without query strings. A rejected signature and a hash mismatch are errors;
network failures are warnings.

**Testing seam.** A build made with `TABLE_CRAFT_UPDATE_TEST_BUILD=1` is named "TableCraft Update
Test" (own bundle, profile, keychain item) and, like a development run, honours
`TABLE_CRAFT_UPDATE_MANIFEST_URL`, `TABLE_CRAFT_UPDATE_PUBLIC_KEY` (a PEM file) and
`TABLE_CRAFT_UPDATE_FIRST_CHECK_MS`, and accepts `http:` loopback assets when the manifest URL is
overridden. A release build compiles that path out.

**Keychain.** The keychain grants "TableCraft Safe Storage" to an ad-hoc signed app by its code
hash, which every build changes. After an update the new version blocks at startup on macOS's
prompt for the login keychain password; Always Allow keeps saved passwords readable, Deny leaves
them unreadable (connect asks for them) until a later launch is allowed. The ready popover says so
on macOS.

## Packaging

Plan 014, decision 033. electron-builder (`packages/desktop/electron-builder.yml`) packs `dist/`
(main, engine, preload, renderer) and a generated `package.json` into `app.asar`, without source
maps or `node_modules`: Vite inlines every runtime dependency, so `@table-craft/core` and
`plugin-api` are dev dependencies. The built-in plugins ship beside the archive as real files in
`<resources>/plugins/<id>/`, with `<resources>/icon.png`; the engine forks from inside the archive.
`main/paths.ts` (`appPaths`) resolves the engine, preload, renderer, plugin directory and icon for
a development run (under `dist/`) and a packaged one.

Targets: a DMG and a zip per macOS architecture (arm64, x64), the zip being what the in-app
update downloads, NSIS for Windows x64, AppImage for Linux x64,
each named `TableCraft-<version>-<arch>.<ext>` in `packages/desktop/release/`. The product is
TableCraft; the profile folder, the Linux executable, the app id, the packages and the IPC
channels keep `table-craft` (decision 037).
`bun run desktop:package` builds the host's platform and architecture (`--x64` builds an Intel DMG
on Apple silicon); `bun run desktop:package:dir` builds only the unpacked app. Both go through
`scripts/package.ts`, which never publishes.

The version comes from git (`scripts/version.ts`): `X.Y.Z` when HEAD carries exactly one
`vX.Y.Z` tag, `0.0.0-dev.<short sha>` otherwise, and two such tags stop the build naming both. It
is passed as `extraMetadata.version`; nothing in the tree holds it. A development run reports
`0.0.0`.

Signing: without a Developer ID (`CSC_LINK` or `CSC_NAME`), macOS builds are signed ad hoc with
the hardened runtime off, so the arm64 app launches; a Developer ID build keeps the hardened runtime
with `build/entitlements.mac.plist` (JIT and unsigned executable memory). Windows and Linux are
unsigned. The icon is `build/icon.png`, a woven 3×3 grid of ribbons on an indigo tile: a 1024 px
raster with a transparent margin around an 824 px tile, the macOS icon grid. It is the source
itself, generated as an image rather than drawn from vectors, so a new icon replaces the file.

`bun run test:smoke:packaged` builds the unpacked app and runs `test/e2e/packaged.smoke.test.ts`
against it through `TABLE_CRAFT_APP_EXECUTABLE` (`scripts/packaged-executable.ts` names the
host's binary): the three plugins available, the built version, the daily loop on SQLite and a
setting surviving a relaunch; `test:smoke:packaged:db` adds PostgreSQL and MySQL through the
bundled drivers. `test/e2e/workflows.ts` holds the daily loop, which `workflows.smoke.test.ts`
runs on the development build against each database.

CI (`.github/workflows/ci.yml`) runs on every push and pull request: `verify` on Ubuntu (lint,
format, typecheck, unit tests, the contract suite on PostgreSQL and MySQL) and `package` on macOS
arm64, macOS x64, Windows x64 and Linux x64, each building its installer, running the packaged
suite on SQLite and uploading the installer. The macOS jobs block; Windows and Linux are
best-effort. A `v*` tag adds a draft GitHub release with the installers, `update-manifest.json` and its
signature once the blocking jobs pass (see In-app update).

## Storage

Decision 010.
