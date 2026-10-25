# 108: SQLite and MySQL ship in the box; other plugins download on demand

Status: Accepted. Plan 057.

## Decision

The installer carries two datasource plugins, SQLite and MySQL. Every other plugin TableCraft
offers is optional: it is built by the same Vite config, never packaged, published to npm with each
release (decision 109) and downloaded by the app when the user asks for it or a saved datasource
needs it (decision 110). PostgreSQL is the first optional plugin; Oracle and SQL Server join it.

- `packages/desktop/vite.plugins.config.ts` holds both lists: `BUILT_IN_PLUGINS = ["sqlite",
"mysql"]` and `OPTIONAL_PLUGINS = ["postgres"]`. `--mode <id>` builds either, built-ins to
  `dist/resources/plugins/<id>` (copied into the installer by `extraResources`), optional ones to
  `dist/optional-plugins/<id>`, which electron-builder excludes.
- A development run (`bun run desktop`) and the smoke harness load `dist/optional-plugins/` as an
  extra plugin root when the app is not packaged, so every PostgreSQL scenario keeps working
  unchanged. `TABLE_CRAFT_DEVELOPMENT_PLUGINS=0` turns that root off, which the plugins-on-demand
  suite uses to act as a fresh packaged install. The packaged app never reads it.
- The compiled-in catalog (`main/pluginStore/catalog.ts`) names each optional plugin: id, display
  name, npm package, URL schemes and approximate download size. A test pins its ids to
  `OPTIONAL_PLUGINS` and its names and schemes to the manifests.

## Rationale

Every database a desktop IDE supports grows its installer by its driver, and most users reach one
or two. SQLite needs nothing and MySQL is the database most of our users open first, so both stay
in the box and work offline from the first launch; the user ruled they stay. PostgreSQL, Oracle and
SQL Server are larger drivers a user can fetch in a second when they first add such a datasource.

A plugin that is not in the installer must still be one the project builds, tests and releases,
or "optional" becomes "unmaintained". Building optional plugins with the same config and loading
them in development keeps them on the same contract suite, smoke suites and review path as the
built-ins.

## Consequences

**A new optional plugin appends to `OPTIONAL_PLUGINS` and to `PLUGIN_CATALOG`.** The catalog test
fails until both and the manifest agree; the build script chain builds every mode.

**The packaged suite seeds PostgreSQL.** `test/e2e/packaged.smoke.test.ts` checks the picker offers
PostgreSQL for download and copies the built bundle into the profile's managed folder before its
PostgreSQL daily loop, the way an installed plugin would be.

**Users upgrading from a version with PostgreSQL built in** get it installed in the background on
first start (decision 110), with no prompt.
