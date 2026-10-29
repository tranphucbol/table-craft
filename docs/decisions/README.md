# Decisions

Architecture decision records. One file per decision, numbered, never renumbered. A decision that
is later reversed keeps its file and gains a status pointing at the record that reversed it.

A record is written when a meaningful alternative existed, or when a future reader would otherwise
reopen the choice. A ruling with no live alternative belongs in the diff, not here.

Status is one of `Proposed`, `Accepted`, `Reversed by NNN`. Claim the next number when a record is
started, not when it is merged.

| #   | Decision                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | [Electron, with Bun as the toolchain](001-electron-with-bun-as-the-toolchain.md)                                                                                       |
| 002 | [Three processes, one engine per datasource](002-three-processes-one-engine-per-datasource.md)                                                                         |
| 003 | [The renderer stack is preman's](003-the-renderer-stack-is-premans.md)                                                                                                 |
| 004 | [Four kinds of package](004-four-kinds-of-package.md)                                                                                                                  |
| 005 | [Plugins load at runtime, built-ins included](005-plugins-load-at-runtime-built-ins-included.md)                                                                       |
| 006 | [Plugins are trusted and run in the engine](006-plugins-are-trusted-and-run-in-the-engine.md)                                                                          |
| 007 | [Capabilities, not plugin ids, shape the UI](007-capabilities-not-plugin-ids-shape-the-ui.md)                                                                          |
| 008 | [The plugin owns its language](008-the-plugin-owns-its-language.md)                                                                                                    |
| 009 | [Result sets stay in the engine](009-result-sets-stay-in-the-engine.md)                                                                                                |
| 010 | [One global datasource list](010-one-global-datasource-list.md)                                                                                                        |
| 011 | [Auto-commit, with guards](011-auto-commit-with-guards.md)                                                                                                             |
| 012 | [Appearance is data](012-appearance-is-data.md)                                                                                                                        |
| 013 | [Every plugin passes one contract suite](013-every-plugin-passes-one-contract-suite.md)                                                                                |
| 014 | [What v1 ships](014-what-v1-ships.md)                                                                                                                                  |
| 015 | [Every command is an action](015-every-command-is-an-action.md)                                                                                                        |
| 016 | [Plans and evidence are tracked](016-plans-and-evidence-are-tracked.md) (superseded by 035)                                                                            |
| 017 | [Database values cross the wire as the database prints them](017-database-values-cross-the-wire-as-the-database-prints-them.md)                                        |
| 018 | [The datasource comes from the environment until there is a list](018-the-datasource-comes-from-the-environment-until-there-is-a-list.md)                              |
| 019 | [Connection forms are manifest data](019-connection-forms-are-manifest-data.md)                                                                                        |
| 020 | [Secrets live in main and reach only their engine](020-secrets-live-in-main-and-reach-only-their-engine.md)                                                            |
| 021 | [Main stops engines, and Run reconnects](021-main-stops-engines-and-run-reconnects.md)                                                                                 |
| 022 | [The schema is the unit of introspection](022-the-schema-is-the-unit-of-introspection.md)                                                                              |
| 023 | [Plugins share a splitter from plugin-api](023-plugins-share-a-splitter-from-plugin-api.md)                                                                            |
| 024 | [The renderer answers before the window closes](024-the-renderer-answers-before-the-window-closes.md)                                                                  |
| 025 | [Result cursors stay open until the session moves on](025-result-cursors-stay-open-until-the-session-moves-on.md)                                                      |
| 026 | [Table edits key on the primary key and submit as one transaction](026-table-edits-key-on-the-primary-key-and-submit-as-one-transaction.md)                            |
| 027 | [Actions scope to a tab kind, and chords clash only where they overlap](027-actions-scope-to-a-tab-kind-and-clash-only-where-they-overlap.md)                          |
| 028 | [Completion asks the engine, which reads the cached catalog](028-completion-asks-the-engine-which-reads-the-cached-catalog.md)                                         |
| 029 | [Object definitions come from the database, not from the cached catalog](029-object-definitions-come-from-the-database.md)                                             |
| 030 | [Query history lives in main, and the renderer records it](030-query-history-lives-in-main-and-the-renderer-records-it.md)                                             |
| 031 | [Plans come from the plugin as one tree, and Explain Analyse runs on the console's session](031-plans-come-from-the-plugin-and-analyse-runs-on-the-console-session.md) |
| 032 | [Settings live in main, and the renderer applies them](032-settings-live-in-main-and-the-renderer-applies-them.md)                                                     |
| 033 | [The packaged app is `dist/` in asar, with the built-in plugins beside it](033-the-packaged-app-is-dist-in-asar-with-plugins-beside-it.md)                             |
| 034 | [The window draws its own title bar, and keeps the native window controls](034-the-window-draws-its-own-title-bar-and-keeps-native-controls.md)                        |
| 035 | [Plans and evidence stay local](035-plans-and-evidence-stay-local.md)                                                                                                  |
| 036 | [README media is recorded by a script](036-readme-media-is-recorded-by-a-script.md)                                                                                    |
| 037 | [The product is named TableCraft](037-the-product-is-named-tablecraft.md)                                                                                              |
| 038 | [Main writes one redacted, structured app log](038-main-writes-one-redacted-structured-app-log.md)                                                                     |
| 039 | [The daily-friction release amends the v1 scope](039-the-daily-friction-release-amends-the-v1-scope.md)                                                                |
| 040 | [Exports stream in the engine as background tasks](040-exports-stream-in-the-engine-as-background-tasks.md)                                                            |
| 041 | [XLSX is written in-house as a streamed ZIP](041-xlsx-is-written-in-house-as-a-streamed-zip.md)                                                                        |
| 042 | [Reformat is the plugin's language, over `sql-formatter`](042-reformat-is-the-plugins-language-over-sql-formatter.md)                                                  |
| 043 | [Query parameters are found by the plugin and bound by the driver](043-query-parameters-are-found-by-the-plugin-and-bound-by-the-driver.md)                            |
| 044 | [The app signs its own updates](044-the-app-signs-its-own-updates.md)                                                                                                  |
| 045 | [The update lives in the main toolbar, before Settings](045-the-update-lives-in-the-main-toolbar-before-settings.md)                                                   |
| 046 | [Imports stream into a plugin-owned bulk insert as background tasks](046-imports-stream-into-a-plugin-owned-bulk-insert-as-background-tasks.md)                        |
| 047 | [PostgreSQL imports use COPY through `pg-copy-streams`](047-postgresql-imports-use-copy-through-pg-copy-streams.md)                                                    |
| 048 | [The current namespace comes from the console](048-the-current-namespace-comes-from-the-console.md)                                                                    |
| 050 | [Find and the local filter run in the engine, on display text](050-find-and-local-filter-run-in-the-engine-on-display-text.md)                                         |
| 052 | [Object DDL is a plugin capability over a typed change](052-object-ddl-is-a-plugin-capability-over-a-typed-change.md)                                                  |
| 053 | [SQLite alters a table by rebuilding it](053-sqlite-alters-a-table-by-rebuilding-it.md)                                                                                |
| 054 | [The engine keeps sessions alive, times statements out and reconnects](054-the-engine-keeps-sessions-alive-times-statements-out-and-reconnects.md)                     |
| 055 | [Connection URLs are manifest data](055-connection-urls-are-manifest-data.md)                                                                                          |
| 056 | [A console result is editable when it provably reads one table](056-a-console-result-is-editable-when-it-provably-reads-one-table.md)                                  |
| 057 | [Submit preempts Run in a grid with pending edits](057-submit-preempts-run-in-a-grid-with-pending-edits.md)                                                            |
| 058 | [A closing result holds the session](058-a-closing-result-holds-the-session.md)                                                                                        |
| 059 | [Tab replaces and Enter inserts a completion](059-tab-replaces-and-enter-inserts-a-completion.md)                                                                      |
| 060 | [The plugin writes the console's namespace switch](060-the-plugin-writes-the-console-namespace-switch.md)                                                              |
| 061 | [An aligned layout of our own is the default format](061-an-aligned-layout-of-our-own-is-the-default-format.md)                                                        |
| 062 | [The aligned layout never half-formats](062-the-aligned-layout-never-half-formats.md)                                                                                  |
| 063 | [Live tests run in a headless Linux box](063-live-tests-run-in-a-headless-linux-box.md)                                                                                |
| 064 | [Ported themes are generated, audited data](064-ported-themes-are-generated-audited-data.md)                                                                           |
| 065 | [The theme is chosen from a previewing dropdown](065-the-theme-is-chosen-from-a-previewing-dropdown.md)                                                                |
| 066 | [Server messages reach the user](066-server-messages-reach-the-user.md)                                                                                                |
| 067 | [Importing another app's connections and secrets](067-importing-another-apps-connections-and-secrets.md)                                                               |
| 068 | [A datasource remembers where it came from](068-a-datasource-remembers-where-it-came-from.md)                                                                          |
| 069 | [The must-have release amends the v1 scope](069-the-must-have-release-amends-the-v1-scope.md)                                                                          |
| 070 | [SSH tunnels live in core, behind the manifest's network fields](070-ssh-tunnels-live-in-core-behind-the-manifest-network.md)                                          |
| 071 | [SSH host keys are trusted on first use, after asking](071-ssh-host-keys-are-trusted-on-first-use-after-asking.md)                                                     |
| 072 | [Certificate files are paths the plugin reads on connect](072-certificate-files-are-paths-the-plugin-reads-on-connect.md)                                              |
| 073 | [A tunneled connection checks the configured host's name](073-a-tunneled-connection-checks-the-configured-host-name.md)                                                |
| 080 | [File consoles save explicitly, scratch consoles autosave](080-file-consoles-save-explicitly-scratch-consoles-autosave.md) (saving superseded by 089)                  |
| 081 | [SQL scripts stream through the plugin splitter](081-sql-scripts-stream-through-the-plugin-splitter.md)                                                                |
| 082 | [Error positions travel from the plugin to the editor](082-error-positions-travel-from-the-plugin-to-the-editor.md)                                                    |
| 083 | [A multi-statement run asks before it continues past an error](083-a-multi-statement-run-asks-before-it-continues-past-an-error.md)                                    |
| 088 | [Server sessions are a plugin capability](088-server-sessions-are-a-plugin-capability.md)                                                                              |
| 089 | [File consoles autosave, and Save on a scratch console asks for a file](089-file-consoles-autosave-and-save-asks-for-a-file.md)                                        |
| 090 | [Routine calls are written by the plugin](090-routine-calls-are-written-by-the-plugin.md)                                                                              |
| 091 | [File size budget and module layout of the engine](091-file-size-budget-and-module-layout-of-the-engine.md)                                                            |
| 096 | [The headless suite runs files in parallel](096-headless-suite-runs-files-in-parallel.md)                                                                              |
| 097 | [Function specs with server ranges](097-function-specs-with-server-ranges.md)                                                                                          |
| 098 | [Signature help is answered by the plugin](098-signature-help-is-answered-by-the-plugin.md)                                                                            |
| 099 | [Normal runs test MySQL and the remote TiDB](099-normal-runs-test-mysql-and-remote-tidb.md)                                                                            |
| 100 | [Dialect options for Oracle and T-SQL](100-dialect-options-for-oracle-and-t-sql.md)                                                                                    |
| 101 | [A plugin may name a column's type class](101-a-plugin-may-name-a-column-type-class.md)                                                                                |
| 102 | [The Oracle plugin runs node-oracledb in thin mode only](102-oracle-plugin-thin-mode-only.md)                                                                          |
| 103 | [Oracle schemas are namespaces, and packages are routine owners](103-oracle-schemas-are-namespaces-and-packages-are-routine-owners.md)                                 |
| 106 | [Plugin API 1.0 follows semver](106-plugin-api-1-0-follows-semver.md)                                                                                                  |
| 107 | [Plugin API compatibility is checked, not promised](107-plugin-api-compatibility-is-checked.md)                                                                        |
| 108 | [SQLite and MySQL ship in the box; other plugins download on demand](108-sqlite-and-mysql-ship-other-plugins-download.md)                                              |
| 109 | [One npm package per optional plugin, released with the app](109-one-npm-package-per-optional-plugin.md)                                                               |
| 110 | [The app installs plugins from the npm registry](110-the-app-installs-plugins-from-the-registry.md)                                                                    |
| 111 | [SQL inspections run in the plugin, live in the editor](111-sql-inspections-run-in-the-plugin.md)                                                                      |
| 112 | [A `commands` capability for non-SQL consoles](112-a-commands-capability-for-non-sql-consoles.md)                                                                      |
| 113 | [A `keyValue` capability and the key tree](113-a-keyvalue-capability-and-the-key-tree.md)                                                                              |
| 114 | [Commands and server figures may target a node; cluster reachability is the user's map](114-cluster-nodes-are-the-users-map.md)                                        |
| 115 | [Key edits are guarded, applied as one MULTI, and not undoable](115-guarded-key-edits.md)                                                                              |
| 116 | [Redis 5.0 is supported through feature probes, not version branches](116-redis-5-0-is-supported-through-feature-probes.md)                                            |
| 117 | [Shown schemas are a per-datasource allow-list](117-shown-schemas-are-a-per-datasource-allow-list.md)                                                                  |
| 118 | [Grid helpers compute and touch files in the engine](118-grid-helpers-compute-and-touch-files-in-the-engine.md)                                                        |
| 119 | [Console replies name the key they read, and whole-key replies edit like the key tab](119-console-replies-name-their-key.md)                                           |
| 120 | [Motion is plain CSS, and surfaces animate in only](120-motion-is-plain-css-and-surfaces-animate-in-only.md)                                                           |
| 121 | [Editor groups move tabs without duplicating sessions](121-editor-groups-move-tabs-without-duplicating-sessions.md)                                                    |
| 122 | [SQL snippets are profile templates](122-sql-snippets-are-profile-templates.md) (SQL-only model superseded by 123)                                                     |
| 123 | [Snippets are scoped text templates](123-snippets-are-scoped-text-templates.md)                                                                                        |
| 124 | [SQL Server plugin on tedious](124-sql-server-plugin-on-tedious.md)                                                                                                    |
| 125 | [T-SQL batches and result sets](125-t-sql-batches-and-result-sets.md)                                                                                                  |
| 126 | [The MCP server is a fourth process](126-mcp-server-is-a-fourth-process.md)                                                                                            |
| 127 | [Agents get per-datasource access, and writes wait for the user](127-agents-get-per-datasource-access.md)                                                              |
| 128 | [Plugins name the products they speak, and datasource rows draw their logos](128-plugins-name-their-products-and-rows-draw-logos.md)                                   |
| 129 | [The database backs the statement limit where it can](129-the-database-backs-the-statement-limit-where-it-can.md)                                                      |
| 130 | [Agents can be asked before reads](130-agents-can-be-asked-before-reads.md)                                                                                            |
| 131 | [A datasource remembers how its timeout is enforced](131-a-datasource-remembers-how-its-timeout-is-enforced.md)                                                        |
| 132 | [User docs are a short README and a guide](132-user-docs-are-a-short-readme-and-a-guide.md)                                                                            |
