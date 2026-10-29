# Launching the app by hand

## On a test database

`bun run desktop` builds and launches the app with the datasources saved in the profile's
`datasources.json`, empty at first; add them in the Data Sources dialog (⌘N in the Database pane).

`TABLE_CRAFT_DATASOURCE` adds one ephemeral datasource on top, never saved, and opens a console on
it (decision 018 and its amendment). For the servers of
[databases.md](databases.md), started with `bun test/db/up.ts`:

```sh
# PostgreSQL, from TABLE_CRAFT_DATABASES=postgres bun test/db/up.ts
TABLE_CRAFT_DATASOURCE='{"id":"pg","pluginId":"postgres","config":{"host":"127.0.0.1","port":55432,"database":"table_craft","user":"table_craft","password":"table_craft"}}' bun run desktop

# MySQL
TABLE_CRAFT_DATASOURCE='{"id":"mysql","pluginId":"mysql","config":{"host":"127.0.0.1","port":53306,"database":"table_craft","user":"table_craft","password":"table_craft"}}' bun run desktop

# In-memory SQLite
TABLE_CRAFT_DATASOURCE='{"id":"scratch","pluginId":"sqlite","config":{"path":":memory:"}}' bun run desktop
```

`TABLE_CRAFT_USER_DATA` points the profile (layout, datasources, secrets, settings, themes, user
plugins) at another directory. Use a fresh one under the session's temporary directory, so a manual
check never changes the user's own profile.

A window launched this way takes the screen. Prefer a smoke scenario in the headless box for
anything that should be repeatable or leave evidence; launch by hand only to look at something
once, and close the app afterwards.

## The packaged app

- `bun run desktop:package:dir` builds only the unpacked app; `bun run desktop:package` the
  installer in `packages/desktop/release/` (never commit `release/`).
- `bun run test:smoke:packaged` builds the unpacked app and runs `test/e2e/packaged.smoke.test.ts`
  against it on SQLite; `test:smoke:packaged:db` adds MySQL, and PostgreSQL when
  `TABLE_CRAFT_DATABASES` names it.
- `TABLE_CRAFT_APP_EXECUTABLE` points the harness at a packaged binary instead of the dev build.
- The packaged suite runs on the host: macOS is first-class, Windows and Linux best-effort.
