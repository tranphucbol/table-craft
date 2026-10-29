# table-craft - Agent Guidelines

TableCraft (this repository, `table-craft`) is a desktop database IDE in the spirit of JetBrains
DataGrip: connections, a database explorer, SQL consoles, a result grid and a table data editor.
Users read "TableCraft"; identifiers keep `table-craft` (decision 037). It is a Bun workspace
written in TypeScript, shipped as an Electron app. Databases are reached through datasource
plugins loaded at runtime; MySQL and SQLite ship in the box, PostgreSQL and Redis download on
demand. Read `docs/design/specification.md` for the v1 scope and `docs/decisions/` before changing
the process model, the plugin contract, or where data lives.

## Commands

Run from the repository root. Load the `local-testing` skill (`.agents/skills/local-testing/`)
before running `test:db`, any `test:smoke*` suite, a plan's Live test or the app against a test
database: it holds the servers and their ports, parallel checkouts, the headless box, evidence and
what to do when a run fails.

- `bun install`
- `bun run test` - Vitest, unit tests plus the plugin contract suite against SQLite
- `bun run test:db` - the contract suites against MySQL, TiDB and MariaDB in `docker compose`
  (decision 099); `TABLE_CRAFT_DATABASES` picks the servers, and `test:db:postgres`, `:oracle`,
  `:mssql`, `:redis` and `:all` set it. Run the one for a plugin you touch. A git-ignored `.env`
  names a shared remote TiDB the suites use instead of the container: never start a TiDB container
  by hand or pass `--profile tidb`, and never touch that server outside the run's own `tc_run_*`
  database. A worktree copies the main checkout's `.env` into its root
  (`cp <main checkout>/.env .env`, when the main checkout has one) right after it is made, and one
  running beside another checkout sets its own compose project and ports
- `bun run test:smoke` / `bun run test:smoke:db` - build the app and drive it under Playwright on
  the host; needs a display
- `bun run test:smoke:headless` / `bun run test:smoke:db:headless` - the same suites in the headless
  box (decision 063), where agents and plan sessions run live tests; `TABLE_CRAFT_EVIDENCE_DIR`
  saves a plan's screenshots. `test/e2e/harness.ts` holds the helpers
- `bun run typecheck` - `tsc --noEmit`, every program: the root one, the renderer
  (`packages/desktop/src/renderer/tsconfig.json`) and the renderer tests (`test/renderer/tsconfig.json`)
- `bun run lint` / `bun run lint:fix` - ESLint, including the architecture fences
- `bun run format:check` / `bun run format` - Prettier
- `bun run desktop` - build and launch the app; `TABLE_CRAFT_DATASOURCE` adds one ephemeral
  datasource and opens a console on it (decision 018), `TABLE_CRAFT_USER_DATA` points the profile
  at another directory
- `bun run desktop:package` - the installer for this host's platform and architecture in
  `packages/desktop/release/`, versioned from git by `scripts/version.ts`; macOS is first-class,
  Windows and Linux best-effort. After a build, `bun run --cwd packages/desktop package --x64`
  makes an Intel DMG on Apple silicon. Never commit `release/`
- `bun run desktop:package:dir` - only the unpacked app; `bun run test:smoke:packaged` runs the
  packaged suite against it on the host
- `bun run readme:media` - record the GIFs of the README and the guide into `docs/media/` (decision 036): builds the app,
  reloads the demo `shop` database in the `test:db:postgres` Postgres and the demo keys in db 3 of
  the `test:db:redis` Redis, and drives one scene per GIF. Needs Docker, ffmpeg and a display;
  `README_MEDIA=explain,grid` re-records only those. Re-record after a UI change a GIF shows
- `bun run api:check` - regenerate the plugin-api surface reports (`packages/plugin-api/api/`),
  fail when they differ from the committed ones, and check `API_VERSION` against the reports at
  the last `v*` tag (decision 107); `bun run test` runs the same. `bun run api:report` rewrites the
  reports; commit them with the change
- `bun run --cwd packages/plugin-api build` - stage the publishable `@tablecraft-app/plugin-api` in
  `packages/plugin-api/release/` (git-ignored). Nothing here publishes it
- `bun run plugins:pack` / `bun run plugins:check` / `bun run plugins:publish -- --dry-run` -
  build the optional plugins, pack them and `@tablecraft-app/plugin-api` into `dist/plugin-packages/`,
  load-check every tarball through the real loader, and rehearse the npm publish (decision 109).
  Only `.github/workflows/publish-plugins.yml` publishes, when a release is published; never run
  `plugins:publish` without `--dry-run`, and never push a tag
- `bun scripts/frozen-plugin.ts` - rebuild the frozen SQLite plugin in `test/support/frozen-plugins/`
  only when its API version itself changes before release, never to make a failing run pass

CI (`.github/workflows/ci.yml`) runs `verify` (lint, format, typecheck, test, test:db) and the
packaged suite on macOS arm64 and x64 (blocking), Windows and Linux (best-effort) on every push,
plus `test:db:postgres`, `:oracle` and `:mssql` when `plugins/<id>/**`, the contract suite or
`test/db/schema/<id>*` changed (PostgreSQL also on a tag), and `plugins` (pack, check, publish
`--dry-run`), whose tarballs a tag attaches to the draft release.

Bun is the toolchain only. Electron runs Node, so nothing under `packages/*/src` or
`plugins/*/src` may use `Bun.*` APIs, and drivers must be Node-compatible (decision 001).

Nothing in the tree names the version; the root `package.json` is `0.0.0`. A git tag cuts a
release, following `RELEASING.md`; only a maintainer tags, publishes a draft or approves the
`release` and `plugins` environments.

## Verify

Run all four before considering a change done: `bun run lint`, `bun run format:check`,
`bun run typecheck`, `bun run test`. Touching a plugin or the contract also means `bun run test:db`,
plus `test:db:<id>` for the plugin you touched.

## Working efficiently

Most of a session's tokens go to finding code, not changing it.

- Map unfamiliar code with one `explore` subagent before reading it, using the brief below; then
  read the files it names.
- Read a file whole: source files fit one read (800 code lines, decision 091).
- Send independent reads and searches in one turn.
- Find a spot with `grep -n` and context lines, not `sed -n` windows.
- Do not re-read a file unchanged since you last read it, even after a compression.
- `bun scripts/agent-cost/report.ts <session id or title>` measures a session's steps and cost.

```
Map for <plan or task>. For each claim below, return file:line and one line on what is there:
<claims, one per line>
Also list the functions, tests and fixtures the change will touch, with file:line.
Read only; return a list, no advice.
```

## Layout

```
packages/plugin-api/       @table-craft/plugin-api: the plugin contract and nothing else.
                           Types, Zod schemas, API_VERSION, capability names, and the
                           contract test suite under `testing/`. `sql/` (subpath
                           `@table-craft/plugin-api/sql`) is the shared splitter,
                           classifier, literal helpers, `sqlCompleter` (scope analysis,
                           completion, resolve), `sqlExplainable` and `sqlFormatter`
                           (its aligned layout in `layout*.ts`) plugins build
                           `language` from. `api/` holds the committed surface reports
                           and `compatibility.json`; `scripts/build.ts` stages the
                           publishable package.
                           Depends only on zod and sql-formatter
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
                           the menu popup with its lone-Alt watcher (`menuPopup.ts`).
                           `pluginStore/` installs optional plugins from the npm
                           registry into `<userData>/managed-plugins/` (decision 110):
                           catalog, registry client, tarball reader, managed folder,
                           installer, background updates and the `plugins.*` channels
  src/preload/             contextBridge; hands the engine port to the renderer and relays
                           menu clicks. `menu.ts` declares the native menu as data
  src/engine/              the utilityProcess (decision 091). `protocol.ts` is the only
                           module the engine and renderer share, a barrel over
                           `protocol/<area>.ts`; `engine.ts` parses and dispatches;
                           `context.ts` (with `transfers.ts`, `objectChanges.ts`) is the
                           per-engine state, `connection.ts` (with `statements.ts`) the
                           per-port sessions and runners, `failures.ts` the typed errors
                           and hints. A method's handler is `routes/<prefix>.ts`
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
plugins/<id>/              datasource plugins (@table-craft/plugin-<id>): mysql and
                           sqlite built in, postgres and redis optional (`BUILT_IN_PLUGINS`,
                           `OPTIONAL_PLUGINS` in `vite.plugins.config.ts`, decision 108;
                           an optional one builds to `dist/optional-plugins/`, loads in
                           development runs and downloads from npm). Each depends on
                           plugin-api and its driver alone, and ships a
                           `table-craft-plugin.json` beside `src/`; its
                           `introspect.ts` answers `schemaTree`, its `explain.ts` builds
                           the EXPLAIN statement and reads the plan (subpath `./explain`).
                           `redis` speaks `commands` and `keyValue` (decisions 112-116):
                           `session.ts`, `routing.ts` (per-node routing), `keyspace.ts`,
                           `read.ts`, `apply.ts`, `features.ts` and `resp2.ts`
                           (version fallbacks); its `*.generated.ts` come from
                           `scripts/command-docs.ts`
scripts/agent-cost/        `report.ts`: steps, context and cost of an agent session, read
                           from the OpenCode session store
scripts/api-report/        the plugin-api surface report and its check against the last
                           release (`api:report`, `api:check`, decision 107)
scripts/plugins/           `pack.ts`, `check.ts`, `publish.ts`: the npm packages of the
                           optional plugins and plugin-api (decision 109)
test/                      Vitest suites, `givenX_whenY_thenZ`
  db/                      compose.yml, the fixture schema per dialect, contract runs per database
  e2e/                     Playwright `_electron` suites and the shared harness;
                           `workflows.ts` is the daily loop the dev and packaged suites run;
                           `docker/` the headless box (image, entrypoint, `headless.ts`,
                           `workers.ts`); `serialFiles.ts` the files run one by one
  renderer/                renderer unit tests, typechecked with the DOM lib; no jsdom
  support/                 fixtures shared across suites (type_probe rows, seeded SQLite, configs);
                           `plans/` holds real EXPLAIN outputs, byte-exact (prettier skips it);
                           `frozen-plugins/` the SQLite plugin bundled at API 1.0.0;
                           `pluginRegistry.ts` a loopback npm registry, so no test
                           reaches the real one
  readme/                  the README media suite: the demo `shop` seeds, the screencast
                           recorder (CDP frames to ffmpeg) and the pacing overlays; gated
                           by `readme:media`
.github/workflows/         ci.yml: verify, package per platform, plugin packages, draft
                           release on a v* tag; publish-plugins.yml: npm publish when a
                           release is published
docs/design/               specification.md, design-system.md
docs/decisions/            one numbered file per durable decision
docs/guide/                the user guide, one page per topic, indexed from the README
docs/media/                the GIFs of the README and the guide, recorded by `readme:media` and
                           nothing else
docs/plans/                one plan per feature with its Live test section; untracked
                           except TEMPLATE.md (decision 035)
docs/evidence/NNN/         screenshots from each plan's live test; untracked (decision 035)
```

## Conventions

- Three processes (decision 002). Main holds no state and is not in the request path. The
  renderer reaches the engine over a MessagePort, and every capability is a message in
  `engine/protocol.ts` and its `protocol/` modules. ESLint forbids the renderer
  `@table-craft/core`, any plugin, `node:*`, `electron`, and the Node globals. That fence is the
  architecture; do not route around it.
- Built-in plugins load through the same runtime loader as user plugins (decision 005). Never
  import a plugin statically from core or desktop.
- The UI branches on plugin capabilities, never on plugin ids (decision 007).
- The plugin API is backward compatible within a major (decision 106). A change to
  `@table-craft/plugin-api` only adds: new exports, optional fields and methods, capabilities, and
  contract tests gated on what a plugin declares. Removing, renaming, making something required,
  adding a value to a host→plugin enum without an opt-in, or changing a meaning needs a new major,
  which only the user takes; deprecate instead. A plan takes the next minor of `API_VERSION` (and
  the built-in manifests) only when `bun run api:check` reports an addition since the last release
  tag and main does not already hold that minor; otherwise none. The host calls a new optional
  method only when the plugin has it or declares its capability, never by `apiVersion`.
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
  is filled in. Plans and evidence stay out of git; never commit them (decision 035). A plan
  worked in its own worktree starts by copying the main checkout's `.env` there, so its TiDB
  suites use the remote server; `.env` is git-ignored and never committed.
- `README.md` and `docs/guide/` are for users, `CONTRIBUTING.md` for contributors (decision 132).
  `test/renderer/userDocs.test.ts` checks them against the code: images and links relative to each
  page, anchors across pages, the README's Documentation index against the guide pages and its
  200-line budget, the shortcut table against the action registry, the settings table against the
  defaults, the plugin capabilities, and CONTRIBUTING's `bun run` scripts. Document a behaviour in
  the guide page it belongs to, change the README only for a Highlight, the Quick start or the
  index, and re-record a GIF whose scene changed.
- Branch names, commit subjects and pull requests follow `CONTRIBUTING.md` (Branches, Commits,
  Pull requests); a pull request's description fills in `.github/pull_request_template.md`, drafted
  and opened with the project skill `.agents/skills/create-pr`.
