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
