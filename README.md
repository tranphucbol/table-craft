<p align="center"><img src="packages/desktop/build/icon.png" alt="TableCraft logo" width="128"></p>

# TableCraft

A desktop database IDE in the spirit of JetBrains DataGrip, for PostgreSQL, MySQL, SQLite, Oracle,
SQL Server and Redis.
Connections, a database explorer, SQL consoles with schema-aware completion, a result grid, a table
data editor, DDL and SQL generation, query history and EXPLAIN plans, in one Electron app. Databases
are reached through datasource plugins loaded at runtime.

![How it works](docs/media/how-it-works.gif)

## Highlights

- [DataGrip's keymap and layout](#search-everywhere): tool windows, `⇧⇧` Search Everywhere, `⇧⌘A`
  Find Action, and the chords your hands already know.
- [Completion that knows your schema](#completion-and-navigation): tables after `FROM`, whole join
  conditions after `JOIN`, and the columns of an alias after `o.`.
- [A table editor that shows its SQL](#table-data-editor): edit cells, add and delete rows, preview
  the statements, and submit them in one transaction.
- [Explain Plan as a tree](#explain): estimated and actual rows, costs and timings; Explain Analyse
  asks before it runs a write.
- [Query history and a Services tree](#query-history-and-services): every statement you ran, per
  data source, with its outcome, row count and duration.
- [Large results stay responsive](#result-grid): rows stay in the engine process and the grid reads
  windows of them, so a million-row result does not freeze the window.
- [Themes, fonts and density](#settings-and-appearance): Dark, Light, High contrast, 43
  [ported themes](#themes) such as Gruvbox, Nord and Solarized, or your own theme file, three font
  roles, and a compact layout.
- [Redis, standalone and Cluster](#redis): a key tree that scans instead of blocking, typed key
  tabs with guarded edits, a `redis-cli` console with completion from the server, and a Server tab.
- [Oracle without the Instant Client](#oracle): schemas, packages and their members in the tree,
  `DBMS_OUTPUT` in Output, every SQL function of the manual in completion, sessions and plans.
- [Plugins for any database](#plugins): PostgreSQL, MySQL, SQLite, Oracle and SQL Server are
  plugins, loaded the same way yours would be. SQLite and MySQL come in the box; PostgreSQL, Oracle,
  SQL Server and Redis download the first time you need them.

## Install

Installers are published on the [Releases](https://github.com/tranphucbol/table-craft/releases)
page. Once installed, TableCraft [updates itself](#updates).

| Platform              | File                                   |
| :-------------------- | :------------------------------------- |
| macOS (Apple silicon) | `TableCraft-<version>-arm64.dmg`       |
| macOS (Intel)         | `TableCraft-<version>-x64.dmg`         |
| Windows x64           | `TableCraft-<version>-x64.exe`         |
| Linux x64             | `TableCraft-<version>-x86_64.AppImage` |

The builds are not signed with a paid certificate, so the first launch needs one extra step:

- **macOS**: see [Running the unsigned macOS app](#running-the-unsigned-macos-app) below.
- **Windows**: SmartScreen says _Windows protected your PC_; click **More info**, then **Run
  anyway**.
- **Linux**: make the AppImage executable with `chmod +x TableCraft-*.AppImage` and run it.

### Running the unsigned macOS app

The DMGs are ad-hoc signed rather than notarized, because a Developer ID belongs to whoever ships
the build and not to this repository
([decision 033](docs/decisions/033-the-packaged-app-is-dist-in-asar-with-plugins-beside-it.md)).
macOS quarantines anything a browser downloaded, and Gatekeeper refuses to open a quarantined app it
cannot verify. Depending on the macOS version it says either _“TableCraft” Not Opened. Apple could
not verify “TableCraft” is free of malware…_ or _“TableCraft” is damaged and can’t be opened_. The
app is not damaged; only the download attribute is in the way.

1. Open the DMG and drag `TableCraft.app` to `/Applications`.
2. Clear the attribute the download added:

   ```sh
   xattr -dr com.apple.quarantine /Applications/TableCraft.app
   ```

3. Open TableCraft as usual.

Nothing inside the app changes; only that attribute is removed, and only once per download.

If you would rather not use the terminal and macOS showed _Not Opened_, click **Done**, open
**System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** next to the
message about TableCraft, and confirm with your password. That button appears only for an hour or
so after the refused launch. The _damaged_ message offers no such button; use `xattr`.

Pick the DMG that matches your Mac: `arm64` for Apple silicon, `x64` for Intel. An app you build
yourself with `bun run desktop:package` was never downloaded, so it carries no quarantine and opens
directly.

### Updates

A little after launch, and once a day while it runs, TableCraft asks GitHub whether a newer release
is out. When there is one, an **Update** button appears in the main toolbar, just left of Settings;
nothing is downloaded until you click it and choose **Download**. The button shows the progress,
then turns into **Restart to Update**: TableCraft quits, puts the new version in place of the old
one and opens again. **Skip This Version** hides that release until a newer one comes out; **Later**
closes the popover and leaves the button where it is.

- **Help → Check for Updates…** asks right away, and says so when you are up to date.
- Turn off **Check for updates automatically** in Settings → Advanced to check only from Help.
- Every release is described by a manifest signed with the project's key. TableCraft refuses a
  manifest whose signature does not verify and a download whose SHA-256 does not match it, deletes
  what it fetched and tells you why
  ([decision 044](docs/decisions/044-the-app-signs-its-own-updates.md)).
- On macOS the app replaces itself only from a folder you can write to, such as `/Applications`.
  Run from the disk image or from a folder macOS moved it to, the button explains what to do and
  links to the release instead.
- **macOS asks for your keychain password after every update.** The app is ad-hoc signed, so each
  version looks like a different app to the keychain. Before the new version opens, macOS asks
  for your login keychain password to let it read “TableCraft Safe Storage”; enter it and choose
  **Always Allow**. **Deny** leaves passwords saved _Forever_ unreadable, so connecting asks for
  them, until you allow it at a later launch. Installing a new DMG by hand asks the same.
- On Windows the update runs the installer silently and reopens TableCraft; on Linux it replaces
  the AppImage you started.

Release `v0.1.0` predates updates: install the next release by hand once, and it keeps itself
current from then on.

### Build from source

You need [Bun](https://bun.sh) 1.4.4 (the version in `.bun-version`) and Node 22 or later.

```sh
bun install
bun run desktop            # build and launch the app
bun run desktop:package    # an installer for this machine in packages/desktop/release/
```

## Quick start

1. Press `⌘N` (`Ctrl+N`) in the Database pane, or pick **New Data Source…** from the data source
   widget in the toolbar, and choose PostgreSQL, MySQL, SQLite or Oracle. PostgreSQL and Oracle
   show **Download** the first time: TableCraft fetches the plugin, then opens the form
   ([Databases in the box and on demand](#databases-in-the-box-and-on-demand)).
2. Fill in the connection, click **Test Connection**, then **OK**. The data source appears in the
   Database tree.
3. Select it and press `⇧⌘L` (`Ctrl+Shift+L`) to open a console. Type a query and press `⌘↩`
   (`Ctrl+Enter`) to run the statement at the caret.
4. Select a table in the tree and press `F4` to open its data in the table editor.

## How it works

TableCraft runs three kinds of process. The main process owns windows, menus and saved settings,
and holds no database state. Each connected data source gets its own engine, an Electron utility
process that loads the plugin and runs the queries, so a slow or crashing driver takes down one data
source, not the app. The renderer is a pure view that talks to the engine over a `MessagePort`.
Result rows stay in the engine; the grid reads windows of them, and sorting, copying and exporting
happen there too. Everything a dialect knows about SQL, from splitting statements to completion and
EXPLAIN, lives in its plugin, and the built-in plugins load through the same runtime loader as user
plugins. The [specification](docs/design/specification.md) describes the whole of v1, and
[docs/decisions](docs/decisions/) records why it is built this way.

## Features

### Connections

The **Data Sources** dialog lists your data sources on the left and edits one on the right: name,
folder, comment, the plugin's connection fields, read-only mode and a colour that tints its tabs.
**Test Connection** reports the server version and round trip before you save. Each password has a
save mode: _Forever_ keeps it encrypted by the operating system's keychain, _Until restart_ keeps it
in memory, and _Never_ asks on every connect.

Paste a connection URL such as `postgresql://alice:secret@db.example.com:5432/sales?sslmode=require`
into the URL row, or into Host, and the fields fill themselves; the password goes to its save mode,
never to `datasources.json`. A SQL Server data source also takes a JDBC URL such as
`jdbc:sqlserver://db.example.com:1433;databaseName=sales;encrypt=true`. A SQLite file takes a path
or a `sqlite:` URL. **Copy as URL** in a data
source's context menu copies its URL without the password.

A PostgreSQL, MySQL, Oracle or SQL Server data source can go through an **SSH tunnel**: tick _Use SSH tunnel_ in the
SSH/SSL section and give the bastion's host, port and user, then sign in with a password, a private
key (OpenSSH or PEM, with its passphrase if it has one) or the running SSH agent. The host and port
above stay the database's address as the bastion sees it. The SSH password and passphrase take save
modes like the database password, and **Test Connection** reports each hop. The first time a bastion
is reached, TableCraft shows its key fingerprint and asks before trusting it; trusted keys go to
`ssh_known_hosts.json` beside your data sources, and those already in `~/.ssh/known_hosts` are
trusted too. A bastion whose key changed is refused, naming both fingerprints. If the tunnel drops,
the next statement reopens it.

The **SSL** rows of the same section choose how the connection is encrypted: _Disable_, _Require_
(encrypted, certificate not checked), _Verify CA_ (signed by the CA you trust) or _Verify full_ (and
issued for the host you typed, also through a tunnel). Point _SSL root certificate_ at the server's
CA file, and _Client certificate_ and _Client key_ at yours when the server signs users in by
certificate; a passphrase-protected key asks for its passphrase on connect unless you save it.
TableCraft keeps the paths and reads the files on every connect, so a renewed certificate needs no
edit. **Test Connection** names the TLS version and cipher, and a refused certificate names the CA
file or host it failed on. The URL keeps the paths too (`sslrootcert`, `sslcert`, `sslkey`;
`ssl-ca`, `ssl-cert`, `ssl-key` for MySQL).

Sessions stay healthy on their own. Every connection uses TCP keepalive (30 s by default, under
Advanced). A console idle that long checks its session before the next Run and reconnects if the
connection dropped, saying so in Output; a statement running when the network goes away fails
within one keepalive interval instead of hanging. A **statement timeout** (Settings → Editor →
Running, or per data source under Advanced) cancels a console statement that runs too long, and
**Also have the database stop it** under it hands the limit to MySQL, MariaDB, TiDB or PostgreSQL
too, so the statement stops even when TableCraft cannot reach the server; exports
and imports are not cut by it and are never reconnected mid-way, they stop only when the database
answers nothing for the Transfer stall timeout (Settings → Data Editor → Export and import). An
open transaction is never replaced silently: if its connection drops, the error says its changes
are gone. Running again while the last result still has rows to send waits for that result to
close; one that cannot close within 5 seconds costs a reconnect, which Output reports. TiDB before
6.1 cannot stop a statement safely, so Cancel there resets the session and says so.

![Connections](docs/media/connections.gif)

See [Datasources and secrets](docs/design/specification.md#datasources-and-secrets).

### Import from DataGrip or TablePro

**File → Import Data Sources…**, or the import button beside Add in the Data Sources dialog, brings
your connections over from DataGrip or TablePro. TableCraft only reads their files; it never
changes them. The first step shows what it found on this computer and where it looked; **From a
file…** reads a DataGrip `dataSources.xml` or a TablePro `.tablepro` export instead.

The next step lists every connection with its type, address, user, folder and where its password
comes from. MySQL, MariaDB and TiDB open in the MySQL plugin, PostgreSQL in the PostgreSQL plugin,
SQLite in the SQLite plugin and Oracle in the Oracle plugin (a `jdbc:oracle:thin:@//host:1521/service`
URL or its `@host:1521:SID` form); anything else is listed as not supported. A PostgreSQL or Oracle
connection found before its plugin is installed offers **Install** in its row and maps once the
plugin arrives. A connection that needs an
SSH tunnel, or one already in TableCraft, starts unticked; ticking a duplicate imports a copy named
`<name> (2)`, never overwriting the one you have. Folders and colours come along, under a
`DataGrip` or `TablePro` folder unless you turn that off.

![Import from DataGrip](docs/media/import-datasources.gif)

Passwords:

- **DataGrip** keeps them in the system keychain or in its own KeePass file. A KeePass file is read
  silently. From the macOS Keychain, macOS asks once for each password: click **Allow**, not
  **Always Allow**, so DataGrip's items stay private to DataGrip. Deny once and TableCraft stops
  asking and imports the rest without passwords. On Linux it asks the Secret Service through
  `secret-tool` (package `libsecret-tools`).
- **TablePro** keeps them in its own keychain items, which TableCraft does not read. Export the
  connections from TablePro as an encrypted `.tablepro` file with its passwords, then import that
  file and type the passphrase; it is used once and never stored.

Untick **Import passwords** to bring none: such a data source asks on connect, and you save its
password in the Data Sources dialog.

### Database explorer

The Database tool window (`⌘1`) is a lazy tree: data source, schemas, then `tables`, `views` and
their columns, keys, foreign keys and indexes. Expanding a disconnected data source connects it.
Typing in the tree starts speed search, `F1` shows Quick Documentation for the selected object, and
`⌘B` opens its DDL. **Synchronize** (`⌥⌘Y`) reloads the tree from the database.

![Database explorer](docs/media/explorer.gif)

On a server with many databases, **Manage Shown Schemas…** on a data source picks which databases
or schemas the tree lists, as DataGrip does; the data source then shows how many of them it lists,
such as `3 of 40`. Ones created later stay hidden until you pick them, unless **All schemas** is on.

Each data source shows the logo of the database it is: MySQL, MariaDB or TiDB (whichever the server
says it is on connect), PostgreSQL, SQLite or Redis, in the tree, the Data Sources dialog and the
Services tool window. **View → Brand Icons**, **Toggle Brand Icons** in Find Action, or Settings ›
Appearance › Data sources turns them off for the generic database glyph and the product's name.
Logos take their brand's colour, fitted to the theme; Settings › Appearance › Data sources › Logo
colour draws them in gray instead.

The tree's context menu also changes the database: **New Table…** on a schema, **Modify Table…**
(`⌘F6`) on a table, **Rename…** (`⇧F6`), **Truncate…** and **Drop…** (`⌘⌫`). Every change shows
the DDL it will run first, and **Open in Console** takes it to a console instead. On PostgreSQL and
SQLite it runs in one transaction, so a failing statement leaves nothing changed; MySQL commits each
DDL statement, and its preview says so. Drop and Truncate name the object and its row count, and
Cascade is a checkbox where the database has it. SQLite rebuilds a table for a change its `ALTER
TABLE` cannot make.

![Modify Table](docs/media/modify-table.gif)

See [Database explorer](docs/design/specification.md#database-explorer).

### SQL console

`⌘↩` runs the statement at the caret, or exactly the selected text; `⇧⌘↩` runs the whole console. Each result
opens its own tab next to **Output**, which logs every statement with its row count and time,
followed by the warnings and notices the server left about it (MySQL's and TiDB's `SHOW WARNINGS`,
PostgreSQL's `RAISE NOTICE`); the result tab shows how many warnings there were.
`UPDATE` or `DELETE` without a `WHERE`, `DROP` and `TRUNCATE` are listed in a confirmation before
anything runs. Switch
**Tx: Auto** to **Tx: Manual** to work in a transaction, then **Commit** or **Rollback**. Consoles
are saved as files as you type. Drag the line between the editor and its results to give either
more room; every console keeps the split you last dragged to, across launches.

**Open File…** (`⌘O`) opens `.sql` files from anywhere on disk, such as the migrations in your
project, as file consoles on the data source you are in; each file remembers its data source and
schema for next time, and **File → Recent Files** lists the last ten. A file console saves itself
as you type, as DataGrip does; its tab shows a dot until the write lands. **Save** (`⌘S`) in a
scratch console and **Save As…** (`⇧⌘S`) in any console write it to a file of your choosing, which
it then follows, and **Rename File…** renames the console or the file. When another program
changes the file, a clean console reloads it as the window comes back to the front; one with edits
not yet written shows a banner to reload or keep yours, and is never written over without asking.
Files are UTF-8; Windows line endings are kept as they were.

Right-click an editor tab to close the others, all, or those to its right; to copy its file's path,
show it in Finder (or its folder elsewhere) or rename it; to **Duplicate** it as a new console on
the same data source and schema; or to **Pin** it at the left, where closing many tabs leaves it
open. **Reopen Closed Tab** (`⇧⌘T`) brings back the consoles you closed, newest first.

Drag a tab toward the left or right side of the editor, or right-click it and choose **Split Left**
or **Split Right**, to work in two consoles side by side. Each side keeps its own selected tab;
click inside one to send Run, shortcuts and new consoles there. Drag the divider to resize them.
Splitting moves the existing console, keeping its text, results and connection. With two sides
already open, splitting moves the tab to that side; **Unsplit** brings all tabs together. Closing
the last tab on one side also removes the split. Bulk tab closing and next/previous tab stay within
the selected side. Saved console and table tabs remember their sides and the divider width.

**Run SQL Script…**, on a data source or schema in the Database pane, runs one or more `.sql` files
without opening them: the files are streamed, so a multi-gigabyte dump uses flat memory, and the
run shows its statements and bytes under **SQL Scripts** in Services, where you can cancel it. A
failing statement is handled as in a console run (below): the line asks **Skip**, **Skip All**,
**Stop** or **Retry**, a run that went on ends `done, 2 failed`, and **Go to statement** opens the
file where the database pointed, every failure of that file underlined.

When a statement fails, the console underlines where the database says it went wrong, with a mark in
the gutter and the message on hover; **Go to Error** beside the error jumps there, and `F2` / `⇧F2`
step through the marks. Editing the statement drops its mark. When one of several statements fails,
the run asks above the results: **Skip** it, **Skip All** failures from now on, **Stop**, or
**Retry**. Settings → Advanced → Running → _When a statement fails_ can stop or continue without asking; a run that
went on ends with `12 run, 2 failed.` in Output. In an open transaction PostgreSQL refuses every
later statement until it is rolled back, and Output says so.

While you type, the console checks SQL the way DataGrip does, without running anything: an empty
`WHERE`, a reserved word used as a table name or an unknown column is underlined in red, a
`DELETE` without `WHERE` or `= NULL` in amber, and a redundant `ASC` or alias is greyed out. Hover
a mark for its message and fixes; `⌥↩` (Show Context Actions) at the caret lists them, with
**Suppress for statement**, which writes a `-- noinspection <Id>` line above it, and **Disable
inspection**. `F2` / `⇧F2` visit these too, errors first. Settings → Editor → Inspections turns each
check, or all of them, off. The checks know your tables once the data source is connected.

![Inspections and a failing statement](docs/media/inspections.gif)

**Reformat Code** (`⌥⌘L`) lays out the selection, or the whole console, and one `⌘Z` takes it
back. Queries get the aligned layout: the first item on the keyword's line, the rest of a list
under it, `AS` lined up, `AND`/`OR` under `WHERE`; other statements keep the standard layout. A statement with `:name`, `?` or (on PostgreSQL) `$1` placeholders asks for their values
before it runs; they are bound by the driver, never pasted into the SQL, and the next run starts
from them.

![SQL console](docs/media/console.gif)

See [SQL console](docs/design/specification.md#sql-console).

### Completion and navigation

Completion runs in the engine against a cache of the catalog. After `FROM` it offers relations;
after `JOIN` it offers whole join conditions that follow foreign keys, such as
`customers c ON c.id = o.customer_id`; after `c.` it offers the columns of that alias. `⌃Space`
opens it anywhere. `Enter` inserts the selected option and keeps the rest of the word after the
caret; `Tab` replaces the whole word, as in DataGrip. In an expression it offers the server's
built-in functions with their parameters, return type and a line on what each does; MySQL and
TiDB get the full list for the server's version, so MySQL 8.4 never offers `PASSWORD` and TiDB
offers its own `TIDB_*` functions. Accepting one leaves the caret inside `()`, and a hint above
the call shows every overload with the parameter at the caret in bold; `⌘P` (Parameter Info)
brings it back and `Escape` hides it. `⌘B` (Go to Declaration) on an alias moves the caret to where it is defined, and
on a table opens its DDL. Completion follows `USE` and `SET search_path`: once one runs, the
console's toolbar shows the database or schema it is in and unqualified names complete there; a
`USE` above the caret in a script counts even before it runs. After `USE `, `SET search_path TO `
or `SET SCHEMA ` completion offers the databases or schemas themselves. Click the database or
schema in the toolbar to switch the console to another one; it runs the `USE` or
`SET search_path` for you.

![Completion and navigation](docs/media/completion.gif)

See [Completion and navigation](docs/design/specification.md#completion-and-navigation).

### Snippets

Open **Find Action** and choose **Snippets…** to create, search, edit, preview or delete your
templates. The list starts empty. Give a snippet a name, a completion prefix and a **Snippet body**.
**Applies to** chooses **All text consoles**, **All SQL consoles**, or one installed data source type.
A new snippet defaults to the active data source's type, or All text consoles when none is active.
Type-specific snippets apply to every data source using that plugin, not just one connection;
the choices come from installed plugin names and identities, not syntax-highlighting dialects.

For example, save prefix `sel` for All SQL consoles with this body:

```sql
SELECT * FROM ${table} LIMIT 100;
```

For a Redis-scoped snippet, prefix `getkey` could insert:

```text
GET ${key}${cursor}
```

Type the prefix in a matching SQL or command console and accept the snippet from completion with
`Tab` or `Enter`. It appears alongside the console's usual suggestions. `Tab` and `Shift+Tab` move between editable
fields. `${table}`, `${schema}` and any other named field are text you fill in, not values fetched
from the database; repeated names edit together. `${cursor}` marks the final caret position and
inserts no text. `${key}` is editable text too. Inserting a snippet never runs it: finish the fields,
then run the SQL or command as usual. Editing templates and expanding them need no live database
connection. A command language without a recognized highlighter uses plain text, not SQL keywords.

Snippets are saved in `snippets.json` in your [profile folder](#where-your-data-lives), separately
from settings. Their bodies are plain text; do not put passwords or other secrets in them.
Older SQL-only snippets keep their SQL/dialect restrictions when loaded; reading does not rewrite
the file. The next successful create, update or delete saves the migrated version-2 document.

Future plugins that provide the existing SQL or command-console hooks can use snippets too. This
does not add etcd, Kafka or MongoDB plugins or promise execution support for those systems.

### Result grid

The grid shows the first page (500 rows by default) and keeps the cursor open: **Fetch Next Page**
and **Fetch All** read more. Clicking a header sorts ascending, descending, then not at all; `⌥`-click
adds a second key. `⇧↩`, or double-clicking a cell, opens the value panel for long text and JSON. **Copy** on one
cell copies its bare value; on more it uses the chosen extractor: CSV, TSV, JSON, SQL Inserts or
Markdown. **Export Data…**, on a result or on a
table in the Database pane, writes any of those or Excel (XLSX) in the background: it streams
straight to disk, so a multi-gigabyte export uses flat memory, shows its progress under **Exports**
in Services, and never leaves a half-written file behind when the network drops, the disk fills or
you cancel.

![Result grid](docs/media/grid.gif)

**Find in Result** (`⌘F` in the grid) searches the fetched rows as the grid draws them, with Match
Case, Regular Expression and Whole Cell toggles; `↩` and `⇧↩` step through the matches and
**Filter Rows** hides the rows without one. A column header's menu filters by the focused row's
value, excludes it, or keeps `NULL` or non-`NULL` cells, as removable chips. Both run on the rows
already fetched and say so; **Search All Rows** fetches the rest. Copy takes the rows you see, and
Export asks whether to write the visible rows or the whole result. In the table editor the local
filter sits beside the `WHERE` bar, which still filters on the server.

Select two or more cells and the line under the grid shows their count, distinct values and, for
numbers, an exact sum, average, minimum and maximum; click it to copy, and its menu picks which
show. **Transpose** (`⌥⌘T`) turns records into columns, handy for a wide row. A binary value's
panel saves it to a file, loads a file into the cell, and draws it when it holds a PNG, JPEG, GIF
or WebP image.

![Find, filter and aggregate in the grid](docs/media/grid-helpers.gif)

See [Result grid](docs/design/specification.md#result-grid).

### Table data editor

`F4` on a table opens its rows in a tab with a `WHERE` bar and an `ORDER BY` bar. Edit cells in
place, add rows with `⌘N` and delete them with `⌘⌫`; changes stay pending and highlighted until you
submit. **Preview Pending Changes** (`⇧⌘P`) shows the SQL, and **Submit** (`⌘↩`) runs it in one
transaction: if any statement fails or touches more than one row, everything rolls back and your
edits stay. `⌘B` on a foreign key cell opens the referenced row. A boolean cell edits in a
true/false/NULL list and `Space` flips it; a date or timestamp cell has a calendar picker beside its
text, in the app's theme, that you can drive with the mouse or the arrow keys.

A console result is editable too when it reads one table and shows its primary key, as
`SELECT * FROM orders WHERE …` does: the same chords edit it, and **Submit** runs on the console's
own session, so in manual commit mode your edits wait in its open transaction for **Commit**.
Joins, aggregates, `DISTINCT` and results without a key stay read-only, and the toolbar says why;
computed columns in an editable result take no edits.

![Table data editor](docs/media/table-editor.gif)

See [Table data editor](docs/design/specification.md#table-data-editor).

### Import

**Import Data from File…** on a table, or **Import Data into New Table…** on a schema, reads a CSV
or TSV file into it. The dialog previews the first rows with the delimiter, quote, encoding
(UTF-8 or UTF-16, detected by its BOM), header and NULL text you choose, maps columns by name, and
for a new table infers the column types and shows the `CREATE TABLE` before it runs. The file is
streamed, so a multi-gigabyte import uses flat memory, and it runs in the background under
**Imports** in Services. By default it is all or nothing: a bad row, a cancel or a dropped
connection rolls everything back. Choose **Commit every N rows** to keep what was written and
**Resume** from the first row that was not, and **Skip** to set bad rows aside in
`<file>.rejected.csv` with the reason for each.

![Import](docs/media/import.gif)

See [Import](docs/design/specification.md#import).

### DDL and SQL generation

`⌘B` on a table or view opens its definition, read from the database, in a DDL tab you can copy or
open in a console. The **SQL Generator** (`⌥⌘G`) writes `CREATE`, `DROP`, `SELECT`, `INSERT` or
`UPDATE` statements for the selected objects and opens them in a console.

![DDL and SQL generation](docs/media/sql-generator.gif)

See [DDL and SQL generation](docs/design/specification.md#ddl-and-sql-generation).

### Execute a routine

The tree lists each function and procedure under Routines with its arguments, so every PostgreSQL
or Oracle overload has its own row; an Oracle package's members are listed as `PACKAGE.MEMBER`. **Execute Routine…** on one opens a dialog with a field per argument, a
NULL toggle and, where the argument has a default, a DEFAULT toggle; OUT arguments are listed as
what comes back, and the SQL it will run is shown as you type. **Run** opens a new console on the
routine's schema with that SQL and runs it, values bound rather than pasted in, so the result, the
OUT values and server messages show in the usual result tabs and Output. **Open in Console** opens
the same console without running it. PostgreSQL, MySQL and Oracle support it; an Oracle
`SYS_REFCURSOR` comes back as a result tab.

![Execute a routine](docs/media/routine.gif)

See [Execute a routine](docs/design/specification.md#execute-a-routine).

### Query history and Services

Every statement you run is kept per data source in a local history. **Query History…** (`⌥⌘E`)
searches it, and `↩` puts the chosen statement at the caret. The Services tool window (`⌘8`) shows
each connected data source, a session per tab, and its recent executions with outcome, rows,
duration and start time.

![Query history and Services](docs/media/history-services.gif)

See [Query history and Services](docs/design/specification.md#query-history-and-services).

### Sessions

**Show Sessions…** on a data source opens a tab that lists every session on the server: its PID,
state, user, database, client, how long its query and transaction have run, what it waits on, and
the sessions blocking it. Sessions idle in a transaction are tinted amber and blocked ones red; yours
are tagged. Filter by Hide idle, Hide system or Blocked only, or search; Refresh reads the list
again, and Auto-refresh does so every few seconds. Select a session to see its full query, open it
in a console or explain it, cancel its query, or terminate it after confirming the exact statement.
On a data source coloured red you type the PID to confirm, and a read-only data source cannot stop
anything. **Show in Sessions** on an execution in Services selects the console's own session.
PostgreSQL, MySQL, TiDB and Oracle support it; when your account cannot see everything, the tab
says which grant to ask for.

![Sessions](docs/media/sessions.gif)

See [Sessions](docs/design/specification.md#sessions).

### Agents (MCP)

TableCraft can serve your data sources to AI agents such as Claude Code, OpenCode and Cursor over
the [Model Context Protocol](https://modelcontextprotocol.io). It is off until you turn it on in
**Settings → MCP Server** (or the robot button on the right edge of the window), which listens on `http://127.0.0.1:47820/mcp` on this machine only and
asks every client for a bearer token. **Copy** beside a client puts its configuration, token
included, on the clipboard; the window never shows the token.

Each data source starts **Off** for agents. **Read only** lets an agent list schemas and tables,
describe a table, read its DDL, run `SELECT`s, explain and format SQL; its statements run in a
read-only session, and anything else is refused. **Ask before writes** also lets it propose one
change at a time: the MCP chip in the status bar turns amber, and nothing runs until you open the
request, read the statement and the agent's reason, and choose **Allow once**. Unanswered for a
minute, a request is denied. **Ask before reads** sits between Off and Read only: agents still
browse schemas, tables, columns and key names, but every query that returns rows, and every key
value, waits for you the same way, and writes are refused. While a statement waits, **Plan** in
the request shows how the database would run it, without running it, and marks steps such as a
full table scan or, on TiDB, estimates made without statistics; the request keeps waiting until
you answer. A data source marked read-only stays at Read only, and one coloured
red can be raised past Read only only on its own page in the Data Sources dialog. Answers carry at
most `mcp.rowCap` rows, and a statement running past `mcp.statementTimeoutSeconds` is stopped,
by the database too where it can, even if TableCraft cannot reach it; passwords never leave
TableCraft, and every agent statement is kept in the query history, tagged with the client's name. The app must be running for agents to reach it.

- **Clients.** The first call from a client you have not met turns the chip amber; open it and
  choose **Allow** or **Block**. Unanswered for a minute, the call is refused. Settings → MCP Server
  lists the clients you answered, to flip or forget.
- **Per data source.** Beside the access level, **Schemas** narrows what agents list and read
  (blank keeps the schemas the Database pane shows), **Row cap** overrides `mcp.rowCap`, and
  **Timeout** overrides `mcp.statementTimeoutSeconds`. The (i) before it says what really stops a
  statement there, from the server the data source last connected to: amber when some statements
  keep running past the limit, ringed when TableCraft has not seen the server yet.
- **Tools.** Besides the catalog and query tools, agents can check SQL against the inspections,
  hand a statement to a new console for you to run (**open in console**, which never runs it), read
  the focused console when its data source is exposed, and scan and read Redis keys. They can also
  read `tablecraft://<data source>/<schema>/<table>` resources and two prompts.
- **Watching.** The chip's popover lists connected clients and their last call, with Pause, Agent
  Activity (every call this run, filtered by client and outcome) and Settings. Services shows an
  **Agents** node with each statement still running and a Cancel. A write request can also go to
  **Open in Console** instead of running. Query History filters by **All**, **Me** or **Agents**,
  and the Database pane marks exposed data sources with **AI** while the server runs.

### Redis

The Redis plugin connects to Redis 5.0 or later, **Standalone** or **Cluster** (pick the Mode in the
connection form; a `redis://` or `rediss://` URL fills a standalone one). A cluster is reached from
its seed node; when its nodes announce addresses you cannot reach, map each one in **Node address
map** (`10.0.1.5:6379=127.0.0.1:7001, …`). A cluster cannot go through an SSH tunnel. Redis 5.0
has no ACL users: leave Username empty and give the password alone.

- **Key tree.** Each database lists its keys in folders by `:`, with a type badge and TTL. The tree
  scans 10,000 keys at a time behind a **Load more** row, never with `KEYS`; the filter row takes a
  `MATCH` pattern and a type. **Go to Key…** opens a key by name, and Search Everywhere has a Keys
  tab.
- **Key tabs.** A hash, list, set, sorted set or stream opens in the result grid with its own
  columns; a string opens in a value editor that reads it as Text, JSON, Hex, Base64, MessagePack or
  gzip. The header counts the TTL down and shows length, memory and encoding. Edit cells, add and
  delete rows, preview the commands, and submit them as one `MULTI`; if another client changed the
  key since you read it, you choose to reload or overwrite.
- **Key actions.** New Key…, Rename, Delete, Set TTL…, Remove TTL and Delete Keys Under Folder…
  (a cancellable task in Services).
- **Console.** One command per line with `redis-cli` quoting. Completion and signature help come
  from the server's command docs, and key names complete from a scan. `FLUSHDB` and `FLUSHALL` ask
  you to type the data source's name; `KEYS` and other heavy reads are underlined, with a fix such as
  **Use SCAN**. In a cluster, **Run on** sends a command to one node or every primary.
- **Console results.** A value read (`GET`, `HGET`, `LINDEX`…) opens a one-row `value` tab as well
  as its Output line; a number or status stays in Output, where **Show as Result** opens it as a
  tab. The value panel reads a result's values as the key tab does, Auto first (JSON, gzip,
  MessagePack…), and remembers your format per key pattern. When a result reads one key, **Open
  Key** (`⌘B`) opens it in a key tab. A result that reads a whole key (`GET`, `HGETALL`,
  `SMEMBERS`, `LRANGE key 0 -1`, `ZRANGE key 0 -1 WITHSCORES`) takes edits with the key tab's
  columns and submits them as one guarded `MULTI`; other results say why they are read-only.
- **Server tab.** `INFO` as cards with auto-refresh, every node of a cluster at a glance, and the
  slow log. **Show Sessions…** lists `CLIENT LIST` and unblocks or kills a client.

![Redis key tree and key tab](docs/media/redis-keys.gif)

![Redis console](docs/media/redis-console.gif)

See [Command consoles](docs/design/specification.md#command-consoles),
[Key browser](docs/design/specification.md#key-browser) and
[Server tab](docs/design/specification.md#server-tab).

### Oracle

The Oracle plugin connects to Oracle Database 12.1 or later in thin mode: nothing else to install,
no Instant Client. Connect by **Service name** or **SID**, optionally as SYSDBA, SYSOPER or
SYSBACKUP, or paste `oracle://user@host:1521/FREEPDB1`. SSL is _Verify CA_ or _Verify full_ over
TCPS with the server's CA file; thin mode always checks the certificate, so there is no _Require_.

- **Schemas** are the tree's namespaces, yours first and Oracle-maintained ones under System.
  Packages list their members as `PACKAGE.MEMBER`, one row per overload. `ALTER SESSION SET
CURRENT_SCHEMA` moves the console and its completion to that schema.
- **Values.** `NUMBER` keeps every digit; a `NUMBER(p)` column is an integer and `NUMBER(p,s)` a
  decimal padded to its scale. `DATE` shows its time, `CLOB` reads as text (JSON when it has an
  `IS JSON` check) and `BLOB` and `RAW` as bytes. Oracle stores `''` as NULL, so an empty cell you
  submit reads back as NULL.
- **Scripts.** A PL/SQL block ends at a `/` line and keeps its `;`; a plain statement loses its
  trailing `;` before it is sent. `DBMS_OUTPUT.PUT_LINE` lines show in Output after each statement,
  and a procedure that compiles with errors lists them, with line and column, as warnings.
- **Transactions.** Oracle commits each DDL statement on its own, so `CREATE TABLE` in a manual
  transaction commits what came before it; the table designer says so before it runs.
- **Completion** offers every function of the _SQL Functions_ chapter for the server's version
  (`SYSDATE` without parentheses, `EXTRACT(YEAR FROM …)` with its argument in bold) and the members
  of `DBMS_OUTPUT`, `DBMS_LOB`, `DBMS_STATS`, `UTL_RAW` and other supplied packages after `pkg.`.
- **Sessions** need `SELECT_CATALOG_ROLE` to list other sessions and `ALTER SYSTEM` to cancel or
  kill them; without it the tab lists your own session and says what to ask for.

See [Oracle](docs/design/specification.md#oracle).

### Explain

**Explain Plan** (`⇧⌘E`) shows the plan of the statement at the caret as a tree with estimated rows
and cost; select a node to see its details. **Explain Analyse** runs the statement and adds actual
rows, time and loops; when the statement writes, it asks first. PostgreSQL, MySQL, TiDB and Oracle
support both (Oracle's Explain Analyse needs `SELECT_CATALOG_ROLE`); SQLite has Explain Plan only. Warnings the server gives while planning, such as a hint it
could not apply, show in Output and on the plan tab.

![Explain](docs/media/explain.gif)

See [Explain](docs/design/specification.md#explain).

### Search Everywhere

Press `⇧⇧` to search tables and actions together, or `Tab` to the **Tables** or **Actions** tab;
`↩` on a table opens its data. **Find Action** (`⇧⌘A`) lists every command with its shortcut, so
nothing is only reachable by a chord.

![Search Everywhere](docs/media/search-everywhere.gif)

See [Shell and actions](docs/design/specification.md#shell-and-actions).

### Settings and appearance

**Settings…** (`⌘,`) has pages for Appearance, Editor, Data Editor and Advanced. The theme is a
dropdown: type to filter by name or source, and the theme under the arrow keys or the mouse
previews live; Enter or a click keeps it, Escape puts the previous one back. Themes and density
change live; Follow system picks Dark, Light or High contrast from the operating system. `⌘=`, `⌘-` and
`⌘0` zoom the editor font. Menus, popovers and dialogs fade in briefly and close at once; **Motion**
turns that down to Reduced or Off, or follows the operating system's Reduce Motion (System).

![Settings and appearance](docs/media/settings.gif)

See [Settings and appearance](docs/design/specification.md#settings-and-appearance).

### App log and diagnostics

TableCraft keeps a log of what it does: launches, connections, statements by kind, row count and
duration, exports, engine restarts and errors. It records no passwords, no row values and no SQL
text. **Help → Show Log** opens the Log tool window, newest first, with filters for level, scope
and text; an error notice's **Show in Log** opens it on the records of that request. **Help →
Export Diagnostics…** saves a zip with the logs, versions, settings, data sources without
credentials and recent run metadata, for attaching to a bug report. Turn on **Debug logging** in
Settings → Advanced to record every request while reproducing a problem.

See [App log and diagnostics](docs/design/specification.md#app-log-and-diagnostics).

## Keyboard shortcuts

| Action                    | macOS   | Windows / Linux        |
| :------------------------ | :------ | :--------------------- |
| Run                       | `⌘↩`    | `Ctrl+Enter`           |
| Run All                   | `⇧⌘↩`   | `Ctrl+Shift+Enter`     |
| Explain Plan              | `⇧⌘E`   | `Ctrl+Shift+E`         |
| Next Error                | `F2`    | `F2`                   |
| Previous Error            | `⇧F2`   | `Shift+F2`             |
| Show Context Actions      | `⌥↩`    | `Alt+Enter`            |
| Commit                    | `⌥⇧⌘↩`  | `Ctrl+Alt+Shift+Enter` |
| Reformat Code             | `⌥⌘L`   | `Ctrl+Alt+L`           |
| New Console               | `⇧⌘L`   | `Ctrl+Shift+L`         |
| Open File…                | `⌘O`    | `Ctrl+O`               |
| Save                      | `⌘S`    | `Ctrl+S`               |
| Save As…                  | `⇧⌘S`   | `Ctrl+Shift+S`         |
| Close Tab                 | `⌘W`    | `Ctrl+W`               |
| Reopen Closed Tab         | `⇧⌘T`   | `Ctrl+Shift+T`         |
| Select Next Tab           | `⇧⌘]`   | `Ctrl+Shift+]`         |
| Select Previous Tab       | `⇧⌘[`   | `Ctrl+Shift+[`         |
| Database                  | `⌘1`    | `Ctrl+1`               |
| Services                  | `⌘8`    | `Ctrl+8`               |
| Hide All Tool Windows     | `⇧⌘F12` | `Ctrl+Shift+F12`       |
| Search Everywhere         | `⇧⇧`    | `Double Shift`         |
| Find Action…              | `⇧⌘A`   | `Ctrl+Shift+A`         |
| New Data Source…          | `⌘N`    | `Ctrl+N`               |
| Data Source Properties…   | `⌘;`    | `Ctrl+;`               |
| Disconnect                | `⌘F2`   | `Ctrl+F2`              |
| Synchronize               | `⌥⌘Y`   | `Ctrl+Alt+Y`           |
| Modify Table…             | `⌘F6`   | `Ctrl+F6`              |
| Rename…                   | `⇧F6`   | `Shift+F6`             |
| Drop…                     | `⌘⌫`    | `Ctrl+Backspace`       |
| Go to DDL                 | `⌘B`    | `Ctrl+B`               |
| Go to Declaration         | `⌘B`    | `Ctrl+B`               |
| Open Key                  | `⌘B`    | `Ctrl+B`               |
| Parameter Info            | `⌘P`    | `Ctrl+P`               |
| Quick Documentation       | `F1`    | `F1`                   |
| Open Data                 | `F4`    | `F4`                   |
| SQL Generator…            | `⌥⌘G`   | `Ctrl+Alt+G`           |
| Query History…            | `⌥⌘E`   | `Ctrl+Alt+E`           |
| Preview Pending Changes   | `⇧⌘P`   | `Ctrl+Shift+P`         |
| Submit                    | `⌘↩`    | `Ctrl+Enter`           |
| Find in Result            | `⌘F`    | `Ctrl+F`               |
| Transpose                 | `⌥⌘T`   | `Ctrl+Alt+T`           |
| Toggle Boolean            | `Space` | `Space`                |
| Settings…                 | `⌘,`    | `Ctrl+,`               |
| Increase Editor Font Size | `⌘=`    | `Ctrl+=`               |
| Decrease Editor Font Size | `⌘-`    | `Ctrl+-`               |
| Reset Editor Font Size    | `⌘0`    | `Ctrl+0`               |

Find Action (`⇧⌘A`) lists every action with its shortcut; the specification's
[action table](docs/design/specification.md#shell-and-actions) has the full keymap.

## Settings

Settings live in `settings.json` in your [profile folder](#where-your-data-lives). The Settings
dialog writes it; you can also edit it by hand, and a field that is missing or out of range falls
back to its default without affecting the others.

| Field                                  | Values                                                                                          | Default                                        |
| :------------------------------------- | :---------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| `appearance.theme`                     | `system`, `dark`, `light`, `highContrast`, an id from [Themes](#themes), `user:<file stem>`     | `system`                                       |
| `appearance.density`                   | `comfortable`, `compact`                                                                        | `comfortable`                                  |
| `appearance.motion`                    | `system`, `full`, `reduced`, `off`                                                              | `system`                                       |
| `appearance.systemTitleBar`            | `true`, `false`; read when the window opens                                                     | `false`                                        |
| `appearance.brandIcons`                | `true`, `false`; database logos on data sources                                                 | `true`                                         |
| `appearance.brandIconColor`            | `brand`, `gray`; the logos' colour                                                              | `brand`                                        |
| `appearance.fonts.ui`                  | `family`: a font name, or `null` for the built-in; `sizePx`: 8–32                               | `null`, 13                                     |
| `appearance.fonts.editor`              | `family`: a font name, or `null` for the built-in; `sizePx`: 8–32                               | `null`, 13                                     |
| `appearance.fonts.grid`                | `family`: a font name, or `null` for the built-in; `sizePx`: 8–32                               | `null`, 12                                     |
| `editor.format.style`                  | `aligned`, `standard`; how Reformat Code lays SQL out                                           | `aligned`                                      |
| `editor.format.keywordCase`            | `upper`, `lower`, `preserve`; how Reformat Code cases keywords                                  | `upper`                                        |
| `editor.format.indentWidth`            | 1–8 spaces                                                                                      | 2                                              |
| `editor.format.linesBetweenStatements` | 0–5 blank lines                                                                                 | 1                                              |
| `editor.format.alignAliases`           | `true`, `false`; line up `AS` in a select list (aligned style)                                  | `true`                                         |
| `editor.inspections.enabled`           | `true`, `false`; check SQL as you type                                                          | `true`                                         |
| `editor.inspections.disabled`          | inspection ids to skip, such as `SqlRedundantAlias`                                             | `[]`                                           |
| `console.parameters`                   | `true`, `false`; ask for `:name`, `?` and `$1` values before a run                              | `true`                                         |
| `console.statementTimeoutSeconds`      | 0–86,400; a console statement running longer is cancelled; 0 waits                              | 0                                              |
| `console.sessionsRefreshSeconds`       | 1–3,600; how often a Sessions tab with Auto-refresh on lists again                              | 5                                              |
| `console.runAllOnError`                | `ask`, `stop`, `continue`; what a run of several statements or a SQL script does on a failure   | `ask`                                          |
| `data.nullText`                        | 1–16 characters                                                                                 | `<null>`                                       |
| `data.groupDigits`                     | `true`, `false`                                                                                 | `false`                                        |
| `data.pageRows`                        | 10–10,000                                                                                       | 500                                            |
| `data.fetchAllCap`                     | 1,000–1,000,000, at least `pageRows`                                                            | 100,000                                        |
| `data.aggregates`                      | which of `count`, `distinct`, `sum`, `avg`, `min`, `max` the grid's selection line shows        | `["count","distinct","sum","avg","min","max"]` |
| `data.blobLimitMb`                     | 1–128; the largest file, in MiB, Load from File puts into a binary cell, and Save to File reads | 16                                             |
| `log.level`                            | `info`, `debug`                                                                                 | `info`                                         |
| `data.exportStallSeconds`              | 10–3,600; an export or import the database stalls this long fails                               | 120                                            |
| `updates.checkAutomatically`           | `true`, `false`; look for a new version after launch and daily                                  | `true`                                         |
| `plugins.registryUrl`                  | an `https://` npm registry (plain `http://` only on this machine); where plugins download from  | `https://registry.npmjs.org`                   |
| `mcp.clients`                          | `{ "name", "allowed" }` per MCP client you answered; [Allow or Block](#agents-mcp)              | `[]`                                           |
| `mcp.enabled`                          | `true`, `false`; run the [MCP server](#agents-mcp) for AI agents                                | `false`                                        |
| `mcp.port`                             | 1,024–65,535; the port it listens on, on 127.0.0.1 only                                         | 47,820                                         |
| `mcp.rowCap`                           | 1–1,000; the most rows one agent answer carries                                                 | 100                                            |
| `mcp.statementTimeoutSeconds`          | 1–3,600; an agent's statement running longer is stopped, by the database too where it can       | 120                                            |

A theme of your own is a JSON file in `themes/` in the profile folder. It names any bundled theme,
by its id from [Themes](#themes), as its base and overrides any of its colour tokens; it then
appears as `user:<file stem>`, here `user:solarized`:

```json
{
  "name": "Solarized Dark",
  "base": "dark",
  "colors": {
    "canvas": "#002b36",
    "panel": "#073642"
  }
}
```

A file that does not parse, or whose base is not a bundled theme, is listed under Your themes,
disabled, with its errors. **Reload Themes** in the Settings dialog picks up new or changed files.

## Themes

TableCraft ships its own Dark, Light and High contrast themes and 43 more ported from the
[openchamber](https://github.com/openchamber/openchamber) palettes by way of preman. Each one is
generated from its palette and checked: text, syntax and grid colours meet WCAG AA contrast on every
surface they sit on (High contrast meets AAA for text), and the six data source colours stay apart
from each other. The palettes and their licences are listed in
[`packages/desktop/scripts/palettes/NOTICE`](packages/desktop/scripts/palettes/NOTICE).

| Theme                     | Id                          | Scheme | Source                             | Licence    |
| :------------------------ | :-------------------------- | :----- | :--------------------------------- | :--------- |
| Dark                      | `dark`                      | Dark   | TableCraft                         | —          |
| Light                     | `light`                     | Light  | TableCraft                         | —          |
| High contrast             | `highContrast`              | Dark   | TableCraft                         | —          |
| Aura Dark                 | `aura-dark`                 | Dark   | Aura Theme, daltonmenezes          | MIT        |
| Aura Light                | `aura-light`                | Light  | Aura Theme, daltonmenezes          | MIT        |
| Ayu Dark                  | `ayu-dark`                  | Dark   | Ayu, dempfi                        | MIT        |
| Ayu Light                 | `ayu-light`                 | Light  | Ayu, dempfi                        | MIT        |
| Carbonfox Dark            | `carbonfox-dark`            | Dark   | Nightfox, EdenEast                 | MIT        |
| Carbonfox Light           | `carbonfox-light`           | Light  | Nightfox, EdenEast                 | MIT        |
| Catppuccin Dark           | `catppuccin-dark`           | Dark   | Catppuccin                         | MIT        |
| Catppuccin Light          | `catppuccin-light`          | Light  | Catppuccin                         | MIT        |
| Dracula Dark              | `dracula-dark`              | Dark   | Dracula, Zeno Rocha                | MIT        |
| Dracula Light             | `dracula-light`             | Light  | Dracula, Zeno Rocha                | MIT        |
| Fields of the Shire Dark  | `fields-of-the-shire-dark`  | Dark   | Fields of the Shire, openchamber   | MIT        |
| Fields of the Shire Light | `fields-of-the-shire-light` | Light  | Fields of the Shire, openchamber   | MIT        |
| Flexoki Dark              | `flexoki-dark`              | Dark   | Flexoki, Steph Ango                | MIT        |
| Flexoki Light             | `flexoki-light`             | Light  | Flexoki, Steph Ango                | MIT        |
| Gruvbox Dark              | `gruvbox-dark`              | Dark   | gruvbox, morhetz                   | MIT        |
| Gruvbox Light             | `gruvbox-light`             | Light  | gruvbox, morhetz                   | MIT        |
| JetBrains Dark            | `jetbrains-dark`            | Dark   | JetBrains Darcula / IntelliJ Light | Apache-2.0 |
| JetBrains Light           | `jetbrains-light`           | Light  | JetBrains Darcula / IntelliJ Light | Apache-2.0 |
| Kanagawa Dark             | `kanagawa-dark`             | Dark   | Kanagawa, rebelot                  | MIT        |
| Kanagawa Light            | `kanagawa-light`            | Light  | Kanagawa, rebelot                  | MIT        |
| Mono Dark                 | `mono-dark`                 | Dark   | Mono, openchamber                  | MIT        |
| Mono Light                | `mono-light`                | Light  | Mono, openchamber                  | MIT        |
| Mono Plus Dark            | `mono-plus-dark`            | Dark   | Mono+, openchamber                 | MIT        |
| Mono Plus Light           | `mono-plus-light`           | Light  | Mono+, openchamber                 | MIT        |
| Monokai Dark              | `monokai-dark`              | Dark   | Monokai, Wimer Hazenberg           | MIT        |
| Monokai Light             | `monokai-light`             | Light  | Monokai, Wimer Hazenberg           | MIT        |
| Night Owl Dark            | `nightowl-dark`             | Dark   | Night Owl, Sarah Drasner           | MIT        |
| Night Owl Light           | `nightowl-light`            | Light  | Night Owl, Sarah Drasner           | MIT        |
| Nord Dark                 | `nord-dark`                 | Dark   | Nord, Arctic Ice Studio            | MIT        |
| Nord Light                | `nord-light`                | Light  | Nord, Arctic Ice Studio            | MIT        |
| One Dark Pro Dark         | `onedarkpro-dark`           | Dark   | One Dark Pro, binaryify            | MIT        |
| One Dark Pro Light        | `onedarkpro-light`          | Light  | One Dark Pro, binaryify            | MIT        |
| OpenChamber Dark          | `openchamber-dark`          | Dark   | openchamber                        | MIT        |
| OpenChamber Light         | `openchamber-light`         | Light  | openchamber                        | MIT        |
| preman Dark               | `preman-dark`               | Dark   | preman                             | MIT        |
| Solarized Dark            | `solarized-dark`            | Dark   | Solarized, Ethan Schoonover        | MIT        |
| Solarized Light           | `solarized-light`           | Light  | Solarized, Ethan Schoonover        | MIT        |
| Tokyonight Dark           | `tokyonight-dark`           | Dark   | Tokyo Night, enkia                 | MIT        |
| Tokyonight Light          | `tokyonight-light`          | Light  | Tokyo Night, enkia                 | MIT        |
| Vesper Dark               | `vesper-dark`               | Dark   | Vesper, Rauno Freiberg             | MIT        |
| Vesper Light              | `vesper-light`              | Light  | Vesper, Rauno Freiberg             | MIT        |
| Vitesse Dark              | `vitesse-dark-dark`         | Dark   | Vitesse, Anthony Fu                | MIT        |
| Vitesse Light             | `vitesse-light-light`       | Light  | Vitesse, Anthony Fu                | MIT        |

## Plugins

A plugin is a folder with a `table-craft-plugin.json` manifest and an ES module. The built-in
plugins ship inside the app, others TableCraft offers
[download on demand](#databases-in-the-box-and-on-demand); your own go in `plugins/<id>/` in the
[profile folder](#where-your-data-lives) and load the same way. A plugin that fails to load is
listed as unavailable with the reason; the app keeps running.

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
  the [Sessions](#sessions) view; requires `sql` or `commands`, and `schemaTree` or `keyValue`.
- `routineCall`: writes the statements that call a function or procedure with the values from
  [Execute Routine](#execute-a-routine), OUT values included; requires `sql` and `schemaTree`.
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

```json
{
  "id": "postgres",
  "name": "PostgreSQL",
  "version": "0.0.0",
  "apiVersion": "1.7.0",
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
real databases. See [Plugin contract](docs/design/specification.md#plugin-contract).

### Plugin compatibility

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

### Databases in the box and on demand

SQLite and MySQL (with MariaDB and TiDB) ship inside the app and work offline from the first
launch. PostgreSQL is a plugin TableCraft downloads when you need it, about 190 KB, from npm as
[`@tablecraft-app/plugin-postgres`](https://www.npmjs.com/package/@tablecraft-app/plugin-postgres).
Redis downloads the same way, about 290 KB, as
[`@tablecraft-app/plugin-redis`](https://www.npmjs.com/package/@tablecraft-app/plugin-redis),
Oracle, about 360 KB, as
[`@tablecraft-app/plugin-oracle`](https://www.npmjs.com/package/@tablecraft-app/plugin-oracle), and
SQL Server (2017 and later, and Azure SQL), about 760 KB, as
[`@tablecraft-app/plugin-mssql`](https://www.npmjs.com/package/@tablecraft-app/plugin-mssql)
([decision 108](docs/decisions/108-sqlite-and-mysql-ship-other-plugins-download.md)).

- **Data Sources +** lists PostgreSQL, Redis, Oracle and SQL Server with **Download**. Choosing it
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

TableCraft installs the newest release its plugin API accepts, refuses a download whose sha512
does not match the registry's, and keeps each version in `managed-plugins/` in the profile folder
([decision 110](docs/decisions/110-the-app-installs-plugins-from-the-registry.md)).

## Where your data lives

Everything is stored in one profile folder:

- macOS: `~/Library/Application Support/table-craft`
- Windows: `%APPDATA%\table-craft`
- Linux: `~/.config/table-craft`

| Path                   | Holds                                                                    |
| :--------------------- | :----------------------------------------------------------------------- |
| `datasources.json`     | Data sources and folders, without passwords                              |
| `secrets.json`         | Passwords saved _Forever_ and the MCP token, encrypted with the keychain |
| `ssh_known_hosts.json` | The SSH host keys you chose to trust                                     |
| `consoles/`            | One folder per data source with its console files                        |
| `history.sqlite`       | Query history                                                            |
| `settings.json`        | [Settings](#settings)                                                    |
| `snippets.json`        | Your [Snippets](#snippets), including their plain-text bodies            |
| `logs/`                | The app log, `table-craft.log` and up to four older files of 5 MB each   |
| `update-state.json`    | The version you chose to skip                                            |
| `update-swap.log`      | The last macOS update's swap, logged and removed at the next launch      |
| `themes/`              | Your themes                                                              |
| `plugins/`             | Your plugins                                                             |
| `managed-plugins/`     | Plugins TableCraft downloaded, one folder per version                    |

Passwords are never written to `datasources.json` or to the log, and there is no plaintext fallback:
where the keychain cannot encrypt, _Forever_ is disabled. Apart from the databases you connect to,
TableCraft talks only to GitHub, to [check for updates](#updates), and to the npm registry, to
[download plugins](#databases-in-the-box-and-on-demand), and sends nothing about you to either;
turn **Check for updates automatically** off and it asks only when you choose **Help → Check for
Updates…** or install a plugin.

## Not in v1

- Later: ER diagrams, schema compare and migrations, XLSX and JSON import, a plugin marketplace, a MongoDB
  plugin, a CLI, AI assistance, Git integration, a debugger, notebooks, Docker and
  Kubernetes integration.

## Development

TableCraft is a Bun workspace written in TypeScript. The database suites need Docker; recording the
README GIFs also needs [ffmpeg](https://ffmpeg.org).

```sh
bun install
bun run desktop                # build and launch the app
bun run test                   # unit tests and the plugin contract against SQLite
bun run test:db                # the contract against MySQL in Docker, and TiDB
bun run test:db:postgres       # the same against PostgreSQL (also :oracle, :mssql, :all)
bun run test:db:redis          # the Redis plugin against 7.4, 6.2 and 5.0, standalone and Cluster
bun run test:smoke             # drive the built app with Playwright
bun run test:smoke:db          # the same against MySQL, TiDB and SQLite
bun run test:smoke:headless    # test:smoke in a Linux container, off your screen
bun run test:smoke:db:headless # test:smoke:db in the same container
bun run test:smoke:packaged    # drive the packaged app
bun run lint                   # ESLint, including the architecture fences
bun run typecheck              # every TypeScript program
bun run api:check              # the plugin API surface against the last release
bun run format                 # Prettier
bun run desktop:package        # an installer for this machine
bun run readme:media           # re-record the GIFs in this README
```

[AGENTS.md](AGENTS.md) explains the layout and conventions,
[docs/design](docs/design/) holds the specification and design system, and
[docs/decisions](docs/decisions/) records the decisions behind them.

## License

[MIT](LICENSE)

Database logos come from [Simple Icons](https://simpleicons.org) (CC0). The names and logos are
trademarks of their owners, shown only to say which database a data source is; their use implies
no endorsement.
