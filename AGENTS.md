# table-craft - Agent Guidelines

TableCraft (this repository, `table-craft`) is a desktop database IDE in the spirit of JetBrains
DataGrip: connections, a database explorer, SQL consoles, a result grid and a table data editor.
Users read "TableCraft"; identifiers keep `table-craft` (decision 037). It is a Bun workspace
written in TypeScript, shipped as an Electron app. Databases are reached through datasource
plugins loaded at runtime; PostgreSQL, MySQL and SQLite ship as built-in plugins. Read
`docs/design/specification.md` for the v1 scope and `docs/decisions/` before changing the process
model, the plugin contract, or where data lives.

## Commands

Run from the repository root.

- `bun install`
- `bun run test` - Vitest, unit tests plus the plugin contract suite against SQLite
- `bun run test:db` - the contract suite against PostgreSQL (port 55432) and MySQL (port 53306)
  in `docker compose`, seeded from `test/db/schema/`, plus the TiDB 4 suite (`test/db/tidb.test.ts`,
  port 54000, root with no password, database `test`; an amd64 image, emulated on Apple silicon).
  A second checkout (a parallel worktree) sets `COMPOSE_PROJECT_NAME`, `TABLE_CRAFT_PG_PORT`,
  `TABLE_CRAFT_MYSQL_PORT` and `TABLE_CRAFT_TIDB_PORT` for every `test:db`,
  `test:smoke:db` and `docker compose` command so it gets its own containers
- `bun run test:smoke` - build the app and drive it under Playwright; needs a display
- `bun run test:smoke:db` - the same against PostgreSQL, MySQL and SQLite; set
  `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/NNN` to save a window PNG per scenario for plan NNN's
  live test (each suite captures only for its own plan, via `evidenceFor("NNN")`).
  `test/e2e/harness.ts` holds the launch, run, dialog and capture helpers
- `bun run test:smoke:headless` / `bun run test:smoke:db:headless` - the same two suites in the
  headless box (decision 063): a Linux container under Xvfb with its own keyring, so nothing takes
  the screen, keyboard or clipboard. Agents and plan sessions run live tests here, with the same
  compose variables and `TABLE_CRAFT_EVIDENCE_DIR`; extra arguments narrow the run like `vitest run`
  (`bun run test:smoke:db:headless test/e2e/namespace.smoke.test.ts`). Evidence is Linux evidence;
  macOS-only checks (`titleBar.smoke`, `update.live`, the packaged app) still run on the host
- `bun run typecheck` - `tsc --noEmit`, every program: the root one, the renderer
  (`packages/desktop/src/renderer/tsconfig.json`) and the renderer tests (`test/renderer/tsconfig.json`)
- `bun run lint` / `bun run lint:fix` - ESLint, including the architecture fences
- `bun run format:check` / `bun run format` - Prettier
- `bun run desktop` - build and launch the app. It shows the datasources saved in the profile's
  `datasources.json`, empty at first; add them in the Data Sources dialog (⌘N in the Database
  pane). `TABLE_CRAFT_DATASOURCE` adds one ephemeral datasource on top, never saved, and opens a
  console on it, e.g.
  `{"id":"pg","pluginId":"postgres","config":{"host":"127.0.0.1","port":55432,"database":"table_craft","user":"table_craft","password":"table_craft"}}`
  for the `test:db` Postgres (decision 018 and its amendment). `TABLE_CRAFT_USER_DATA` points the
  profile (layout, datasources, secrets, settings, themes, user plugins) at another directory; the
  smoke harness gives every launch a fresh one, seeds `datasources.json` with `seedDatasources`,
  `settings.json` with `seedSettings` and a user theme with `seedTheme`, and on macOS passes
  `--use-mock-keychain` so `safeStorage` never touches the real keychain
- `bun run desktop:package` - the installer for this host's platform and architecture in
  `packages/desktop/release/`, versioned from git by `scripts/version.ts`; macOS is first-class,
  Windows and Linux best-effort. After a build, `bun run --cwd packages/desktop package --x64`
  makes an Intel DMG on Apple silicon. Never commit `release/`
- `bun run desktop:package:dir` - only the unpacked app, which the packaged suite launches
- `bun run test:smoke:packaged` - build the unpacked app and run `test/e2e/packaged.smoke.test.ts`
  against it on SQLite; `test:smoke:packaged:db` adds PostgreSQL and MySQL. `TABLE_CRAFT_APP_EXECUTABLE`
  points the harness at a packaged binary instead of the dev build
- `bun run readme:media` - record the README GIFs into `docs/media/` (decision 036): builds the app,
  reloads the demo `shop` database in the `test:db` Postgres and drives one scene per GIF. Needs
  Docker, ffmpeg and a display; `README_MEDIA=explain,grid` re-records only those. Re-record after
  a UI change a GIF shows

CI (`.github/workflows/ci.yml`) runs `verify` (lint, format, typecheck, test, test:db) and the
packaged suite on macOS arm64 and x64 (blocking), Windows and Linux (best-effort) on every push.

Bun is the toolchain only. Electron runs Node, so nothing under `packages/*/src` or
`plugins/*/src` may use `Bun.*` APIs, and drivers must be Node-compatible (decision 001).

Nothing in the tree names the version; the root `package.json` is `0.0.0`. A git tag cuts a
release.

## Verify

Run all four before considering a change done: `bun run lint`, `bun run format:check`,
`bun run typecheck`, `bun run test`. Touching a plugin or the contract also means `bun run test:db`.

## Layout

```
packages/plugin-api/       @table-craft/plugin-api: the plugin contract and nothing else.
                           Types, Zod schemas, API_VERSION, capability names, and the
                           contract test suite under `testing/`. `sql/` (subpath
                           `@table-craft/plugin-api/sql`) is the shared splitter,
                           classifier, literal helpers, `sqlCompleter` (scope analysis,
                           completion, resolve), `sqlExplainable` and `sqlFormatter`
                           (its aligned layout in `layout*.ts`) plugins build
                           `language` from.
                           Depends only on zod
packages/core/             @table-craft/core: plugin loader, session manager, result-set
                           store with open cursors and local sort (`results/`), the copy
                           and export extractors (`results/extract/`), the table
                           editor's row identity, generated DML and one-transaction
                           submit (`edits/`), the query history store (`history/`,
                           `<userData>/history.sqlite`), and the catalog cache and the
                           completion catalog over it (`catalog/`). Knows nothing about
                           Electron
packages/desktop/          @table-craft/desktop, the Electron app
  build/                   electron-builder resources: the icon (`icon.png`, 1024 px, the
                           source itself) and the macOS entitlements
  scripts/                 packaging: `package.ts` (electron-builder with the version and
                           signing flags), `version.ts`, `packaged-executable.ts`
  electron-builder.yml     the packaged layout and targets (decision 033)
  src/main/paths.ts        where the engine, preload, renderer, plugins and icon live,
                           in a development run and a packaged one
  src/appearance/          pure, shared by main and the renderer: the token types, the
                           Dark, Light and High contrast themes, both densities,
                           `resolveTheme` and the contrast pairs (`themes.ts`)
  src/settings/            pure, shared: the `settings.json` document, its defaults and
                           ranges, and the field-by-field reader (`settings.ts`)
  src/main/                lifecycle, the window, menus, one engine host per datasource,
                           the datasource list and secrets, console files, the query
                           history (opened at launch, written by the renderer over the
                           `history.*` channels), `settings.json` and the user themes
                           in `<userData>/themes/` (`settings.ts`, `themes.ts`, decision
                           032), the invoke channels (`ipc.ts`); the window chrome per
                           platform, theme and density (`chrome.ts`, decision 034) and
                           the menu popup with its lone-Alt watcher (`menuPopup.ts`)
  src/preload/             contextBridge; hands the engine port to the renderer and relays
                           menu clicks. `menu.ts` declares the native menu as data
  src/engine/              the utilityProcess; `protocol.ts` is the only module the
                           engine and renderer share
  src/renderer/            React 19, Zustand, Tailwind v4, CodeMirror 6; a pure view.
                           `actions/` is the one command registry and keymap; `shell/`,
                           `panes/`, `palette/` the DataGrip-shaped window, whose title
                           bar is `shell/MainToolbar.tsx`; `ui/` shared controls such
                           as `ActionButton.tsx`; `console/`
                           the SQL console: editor, its completion source, result tabs,
                           Output, transactions, the plan view (`PlanView.tsx`, its tree
                           from `model/planTree.ts`);
                           `grid/` the result grid, its toolbar and value panel;
                           `table/` the table data editor: WHERE/ORDER BY bars and the
                           preview; its pending changes are `model/editBuffer.ts`;
                           `state/history.ts` records what runs, `state/executions.ts`
                           feeds the Services tree; `state/settings.ts` holds the
                           settings, `appearance/` applies them as CSS variables,
                           `dialogs/Settings.tsx` edits them
plugins/<id>/              built-in plugins (@table-craft/plugin-<id>): postgres, mysql,
                           sqlite. Each depends on plugin-api and its driver alone, and
                           ships a `table-craft-plugin.json` beside `src/`; its
                           `introspect.ts` answers `schemaTree`, its `explain.ts` builds
                           the EXPLAIN statement and reads the plan (subpath `./explain`)
test/                      Vitest suites, `givenX_whenY_thenZ`
  db/                      compose.yml, the fixture schema per dialect, contract runs per database
  e2e/                     Playwright `_electron` suites and the shared harness;
                           `workflows.ts` is the daily loop the dev and packaged suites run;
                           `docker/` the headless box (image, entrypoint, `headless.ts`)
  renderer/                renderer unit tests, typechecked with the DOM lib; no jsdom
  support/                 fixtures shared across suites (type_probe rows, seeded SQLite, configs);
                           `plans/` holds real EXPLAIN outputs, byte-exact (prettier skips it)
  readme/                  the README media suite: the demo `shop` seeds, the screencast
                           recorder (CDP frames to ffmpeg) and the pacing overlays; gated
                           by `readme:media`
.github/workflows/         ci.yml: verify, package per platform, draft release on a v* tag
docs/design/               specification.md, design-system.md
docs/decisions/            one numbered file per durable decision
docs/media/                the README's GIFs, recorded by `readme:media` and nothing else
docs/plans/                one plan per feature with its Live test section; untracked
                           except TEMPLATE.md (decision 035)
docs/evidence/NNN/         screenshots from each plan's live test; untracked (decision 035)
```

## Conventions

- Three processes (decision 002). Main holds no state and is not in the request path. The
  renderer reaches the engine over a MessagePort, and every capability is a message in
  `engine/protocol.ts`. ESLint forbids the renderer `@table-craft/core`, any plugin, `node:*`,
  `electron`, and the Node globals. That fence is the architecture; do not route around it.
- Built-in plugins load through the same runtime loader as user plugins (decision 005). Never
  import a plugin statically from core or desktop.
- The UI branches on plugin capabilities, never on plugin ids (decision 007).
- SQL knowledge belongs to the plugin (decision 008). The renderer asks the engine for completions
  and statement boundaries; it does not parse SQL itself.
- Result rows stay in the engine; the renderer sees a handle and windows (decision 009).
- Every command is an action in `renderer/actions/` and runs through `invoke` (decision 015).
  Buttons, menus, shortcuts and the palette never call store methods directly; a new chord must not
  clash with an existing one (`test/renderer/keymap.test.ts` checks).
- Secrets go through `safeStorage` and are never written to `datasources.json` or logs, and never
  reach a renderer (decision 020): the renderer sees which keys are stored, not their values.
- TypeScript strict, ESM, `verbatimModuleSyntax`. No magic literals: hoist them to a named
  module constant. Errors are typed and say what to do next.
- Colours, spacing and fonts come from design tokens (`docs/design/design-system.md`), never
  literals in components.

## Code comments

Default to none. Write one only if a reader would otherwise make a worse decision.

Never restate the code, narrate steps, describe the change (that is the commit message), or leave
banners, commented-out code, or TODOs without a link.

Do explain why, especially why the simpler approach fails; state invariants the types cannot;
cite sources for magic values and workarounds; doc-comment exported API only. Prefer a better name
or a named constant over a comment.

## Documentation

- `docs/decisions/` records durable decisions. Start from `docs/decisions/TEMPLATE.md` when a
  meaningful alternative exists or a future reader would otherwise reopen the choice, and add the
  row to `docs/decisions/README.md`.
- `docs/plans/` holds implementation plans. Start from `docs/plans/TEMPLATE.md`. A plan is done
  when its phases are green and its Live test section, with screenshots in `docs/evidence/NNN/`,
  is filled in. Plans and evidence stay out of git; never commit them (decision 035).
- `README.md` is for users. `test/renderer/readme.test.ts` checks it against the code: images,
  anchors, the shortcut table against the action registry, the settings table against the defaults,
  the plugin capabilities, and the `bun run` scripts. Change the README with the behaviour it
  describes, and re-record a GIF whose scene changed.
