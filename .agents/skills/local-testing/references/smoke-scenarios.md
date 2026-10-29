# Smoke scenarios

The smoke suites are Vitest files under `test/e2e/` named `<area>.smoke.test.ts`. They launch the
built app with Playwright's `_electron` (`playwright-core`) and drive it as a user would.
`test/e2e/harness.ts` holds the launch, run, dialog and capture helpers; `test/e2e/workflows.ts`
is the daily loop the dev and packaged suites both run. Read a neighbouring file of the same area
before writing a new one.

## The shape of a file

- A header comment says whose live test it is, what it shows, the databases it needs, and the
  command that regenerates its evidence, such as
  `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/114 bun run test:smoke:headless test/e2e/buttonPress.smoke.test.ts`.
- Gate the `describe` on what the run provides: `describe.runIf(SMOKE_ENABLED)` for SQLite only,
  `describe.runIf(DATABASES_ENABLED)` when it needs the `test/db/compose.yml` servers.
- Gate a scenario on an optional server with `it.skipIf(WITHOUT_POSTGRES)`, `WITHOUT_ORACLE` or
  `WITHOUT_MSSQL` from `test/support/databases.ts`; connect with the configs there
  (`MYSQL_CONFIG`, `POSTGRES_CONFIG`, `ORACLE_CONFIG`, `MSSQL_CONFIG` and the Redis ones), never
  with literals, so a parallel checkout's ports and the headless box's hosts apply.
- Name scenarios `givenX_whenY_thenZ`, pass `SCENARIO_TIMEOUT_MS` as each `it`'s timeout, and close
  the app in `afterEach` with `closeApp` and `CLOSE_HOOK_TIMEOUT_MS`, so a failed scenario never
  leaves a window or dialog behind.
- `const captureWindow = evidenceFor("NNN")` at module scope; call it after the assertions that
  prove what the screenshot shows. `setWindowSize(app, EVIDENCE_WINDOW)` makes every capture the
  same size.

## Harness helpers

| Need                             | Helpers                                                                                                  |
| :------------------------------- | :------------------------------------------------------------------------------------------------------- |
| Launch and close                 | `launchApp` (on the in-memory SQLite `SCRATCH` unless told otherwise), `closeApp`, `newProfile`          |
| A profile prepared before launch | `seedDatasources`, `seedSettings`, `seedTheme`, `seedPlugin`, `readProfileFile`                          |
| Wait and run SQL                 | `waitUntilReady`, `sqlEditor`, `runStatement`, `startStatement`, `runButton`, `cancelButton`, `gridText` |
| Windows, tabs and the tree       | `toolWindow`, `editorTabs`, `activeEditorTab`, `treeNode`, `datasourceStatus`, `consoleAlert`            |
| Keyboard and the palette         | `pressChord`, `pressDoubleShift`, `findAction`, `paletteInput`, `paletteRows`                            |
| Datasources                      | `dataSourcesDialog`, `fillNewDatasource`, `testConnection`, `answerSecretPrompt`, `openConsoleOn`        |
| Evidence                         | `evidenceFor`, `evidenceTextFor`, `EVIDENCE_WINDOW`, `setWindowSize`                                     |

A launch gets a fresh profile from `newProfile` unless `userDataDir` is passed, and on macOS uses
`--use-mock-keychain` so `safeStorage` never touches the real keychain. Secrets cannot be seeded:
they are encrypted by the launched app, so a scenario types them into the dialog.

## Sharing the databases

Every parallel file shares the box's databases. A file that writes fixture rows another file reads,
or asserts an exact object count (`tables 6`) that another file's own table would change, goes into
`SERIAL_SMOKE_FILES` (`test/e2e/serialFiles.ts`) with its reason. Prefer a table of the scenario's
own, dropped after, over editing the shared fixtures. A change to the fixtures themselves goes
under `test/db/schema/`, which reseeds the servers on the next run.
