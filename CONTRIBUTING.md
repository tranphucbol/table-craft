# Contributing to TableCraft

Thanks for helping. This page is the on-ramp: how to set up, which tests a change needs, and the
rules review checks. [AGENTS.md](AGENTS.md) is the full reference for every command, environment
variable and port; this page links to it rather than repeating it.

## Before you start

- **Reporting a bug:** reproduce it, then choose **Help → Export Diagnostics…** and attach the zip.
  It holds the logs, versions, settings, data sources without credentials and recent run metadata,
  and no passwords, row values or SQL text. Turning on **Debug logging** in Settings → Advanced
  before you reproduce records every request
  ([App log and diagnostics](docs/guide/monitoring.md#app-log-and-diagnostics)).
- **Proposing a feature:** open an issue first. The [specification](docs/design/specification.md)
  describes the scope of v1, and the README's [Not in v1](README.md#not-in-v1) lists what waits.
- **Changing the architecture:** read [docs/decisions](docs/decisions/) before changing the process
  model, the plugin contract or where data lives. Each record says why the simpler option failed.

## Set up

You need [Bun](https://bun.sh) 1.4.4 (the version in `.bun-version`) and Node 22 or later. The
database suites need Docker; recording the guide's GIFs also needs [ffmpeg](https://ffmpeg.org).

TableCraft is a Bun workspace written in TypeScript. Bun is the toolchain only: Electron runs Node,
so code under `packages/*/src` and `plugins/*/src` never uses `Bun.*` APIs.

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
bun run format:check           # Prettier, without writing
bun run typecheck              # every TypeScript program
bun run api:check              # the plugin API surface against the last release
bun run format                 # Prettier
bun run desktop:package        # an installer for this machine
bun run readme:media           # re-record the GIFs of the README and the guide
```

Two environment variables keep a development run away from your own profile:

- `TABLE_CRAFT_USER_DATA` points the profile at another folder, so you can start from nothing:
  `TABLE_CRAFT_USER_DATA=/tmp/tc-profile bun run desktop`.
- `TABLE_CRAFT_DATASOURCE` adds one data source for this run only, never saved, and opens a
  console on it. For the PostgreSQL that `test:db:postgres` starts:

  ```sh
  TABLE_CRAFT_DATASOURCE='{"id":"pg","pluginId":"postgres","config":{"host":"127.0.0.1","port":55432,"database":"table_craft","user":"table_craft","password":"table_craft"}}' bun run desktop
  ```

## How the code is laid out

TableCraft runs three kinds of process. Main owns windows, menus and saved files and holds no
database state. Each data source gets its own engine, a utility process that loads the plugin and
runs queries. The renderer is a pure view that reaches its engine over a `MessagePort`; every
capability is a message in `packages/desktop/src/engine/protocol.ts`.

| Folder                 | Holds                                                                       |
| :--------------------- | :-------------------------------------------------------------------------- |
| `packages/plugin-api/` | The plugin contract: types, schemas, capabilities, the shared SQL kit       |
| `packages/core/`       | The plugin loader, sessions, result sets, edits, history, the catalog cache |
| `packages/desktop/`    | The Electron app: `main/`, `preload/`, `engine/` and `renderer/`            |
| `plugins/<id>/`        | One datasource plugin each: MySQL, SQLite, PostgreSQL, Redis, Oracle, MSSQL |
| `test/`                | Vitest suites, the database fixtures and the Playwright harness             |
| `docs/`                | The guide, the specification, the design system and the decisions           |

[AGENTS.md](AGENTS.md#layout) maps every folder in more detail.

## Rules review checks

Each rule has a decision record that says why.

- The renderer never imports `@table-craft/core`, a plugin, `node:*` or `electron`; ESLint fences it
  ([002](docs/decisions/002-three-processes-one-engine-per-datasource.md)).
- Built-in plugins load through the same runtime loader as anyone's; nothing imports a plugin
  statically ([005](docs/decisions/005-plugins-load-at-runtime-built-ins-included.md)).
- The UI branches on what a plugin declares, never on its id
  ([007](docs/decisions/007-capabilities-not-plugin-ids-shape-the-ui.md)).
- SQL knowledge belongs to the plugin; the renderer asks the engine for completions and statement
  boundaries ([008](docs/decisions/008-the-plugin-owns-its-language.md)).
- Result rows stay in the engine; the renderer sees a handle and windows
  ([009](docs/decisions/009-result-sets-stay-in-the-engine.md)).
- Every command is an action, run through `invoke`; buttons, menus, shortcuts and the palette never
  call a store directly, and a new chord must not clash
  ([015](docs/decisions/015-every-command-is-an-action.md)).
- Secrets go through `safeStorage` and never reach `datasources.json`, a log or a renderer
  ([020](docs/decisions/020-secrets-live-in-main-and-reach-only-their-engine.md)).
- The plugin API only adds within a major: new exports, optional fields and methods, capabilities
  ([106](docs/decisions/106-plugin-api-1-0-follows-semver.md)); `bun run api:check` compares it with
  the last release ([107](docs/decisions/107-plugin-api-compatibility-is-checked.md)).
- Code that Electron runs uses Node APIs, and drivers are Node-compatible
  ([001](docs/decisions/001-electron-with-bun-as-the-toolchain.md)).
- Colours, spacing and fonts come from the [design tokens](docs/design/design-system.md), never
  literals in a component. Other magic values are named module constants.
- TypeScript is strict ESM. Errors are typed and say what to do next.
- Comments explain why, not what: no narration, banners, commented-out code or TODOs without a link.

## Tests: what to run for what you changed

| You changed                        | Run                                                                  |
| :--------------------------------- | :------------------------------------------------------------------- |
| The renderer, core or main         | `bun run test`                                                       |
| A plugin or the contract suite     | `bun run test:db`, and that plugin's own, such as `test:db:postgres` |
| What the app shows or does         | `bun run test:smoke:headless`, or `test:smoke:db:headless` with SQL  |
| Packaging or the update flow       | `bun run test:smoke:packaged`                                        |
| The plugin API                     | `bun run api:check`, and `bun run api:report` to commit the reports  |
| A user doc, a setting or an action | `bun run test`, whose `userDocs.test.ts` checks the docs             |

- Tests are named `givenX_whenY_thenZ`.
- `test:db` starts MySQL, TiDB and MariaDB. TiDB is an amd64 image, slow under emulation on Apple
  silicon; `TABLE_CRAFT_DATABASES=mysql bun run test:db` leaves it out.
- Copy `.env.example` to `.env` to point the TiDB suites at a remote server instead. A run works
  only in a `tc_run_*` database of its own and drops it after; never touch anything else there,
  since the server may be shared.
- The headless suites run in a Linux container under Xvfb, so they never take your screen,
  keyboard or clipboard.
- A second checkout running the database suites at the same time needs its own compose project and
  ports; [AGENTS.md](AGENTS.md#commands) lists the variables.

## Before you open a pull request

Run the four checks, and the database suites when you touched a plugin or the contract:

```sh
bun run lint
bun run format:check
bun run typecheck
bun run test
```

CI runs them, with `test:db`, as `verify` on every push, and packages and tests the app on each
platform. `verify` and the macOS packages must pass; Windows and Linux are best-effort.

- One change per commit, and its subject an imperative sentence, as `git log` shows: _Let a
  datasource have the database enforce its console statement timeout_.
- A change to what the app shows comes with a screenshot.

## Docs that change with the code

- Behaviour is documented in the page of [docs/guide](docs/guide/) it belongs to. The README changes
  only for a Highlight, the Quick start or the Documentation index, and stays under 200 lines.
- `test/renderer/userDocs.test.ts` checks the README, this file and the guide against the code:
  images, links and anchors, the shortcut table, the settings table, the themes, the plugin
  capabilities and the scripts above.
- Re-record a GIF with `bun run readme:media` when the scene it shows changed
  ([036](docs/decisions/036-readme-media-is-recorded-by-a-script.md)).
- A choice a future reader would otherwise reopen gets a record in [docs/decisions](docs/decisions/),
  from its `TEMPLATE.md`, and a row in its index.
- `docs/plans/` and `docs/evidence/` are local working files and are never committed
  ([035](docs/decisions/035-plans-and-evidence-stay-local.md)).

## Writing a plugin

[Writing plugins](docs/guide/writing-plugins.md) covers the manifest, the capabilities and how the
plugin API stays compatible. A plugin should pass `runPluginContract` from
`@table-craft/plugin-api/testing`, which the built-in plugins run against real databases.

## Releases

A maintainer cuts a release by pushing a `v*` tag; nothing in the tree names the version. Never push
a tag yourself, and never run `bun run plugins:publish` without `--dry-run`: only the publish
workflow publishes the plugin packages.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
