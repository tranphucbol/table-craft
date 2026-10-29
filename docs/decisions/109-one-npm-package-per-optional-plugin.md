# 109: One npm package per optional plugin, released with the app

Status: Accepted. Plan 057. Amended by 134.

## Decision

Each optional plugin (decision 108) is published as `@tablecraft-app/plugin-<id>`, versioned in
lockstep with the app: the version is the release tag (`packages/desktop/scripts/version.ts`).

- **Contents.** `index.js` (the bundle the app loads, its driver bundled in, no source map),
  `table-craft-plugin.json` with `version` set to the release, a generated README and the
  repository's LICENSE. `package.json` carries `"tableCraft": { "id", "apiVersion" }`, the keyword
  `table-craft-plugin`, `repository` with the plugin's directory and `publishConfig.access:
public`. No dependencies and no install scripts. Built-ins are not published.
- **Pack and check.** `bun run plugins:pack` (`scripts/plugins/pack.ts`) builds the optional
  plugins, stages and `npm pack`s each, and stages and packs `@tablecraft-app/plugin-api` (versioned
  by `API_VERSION`, decision 107) into `dist/plugin-packages/`. `bun run plugins:check` extracts
  every tarball with the app's own tarball reader and loads it through core's `loadPlugins`
  against the current host.
- **CI.** The `plugins` job in `ci.yml` runs pack, check and `plugins:publish --dry-run` on every
  push. On a `v*` tag it uploads the tarballs, and the `release` job attaches them to the draft
  release beside the installers.
- **Publish.** Publishing the draft (`release: published`) runs
  `.github/workflows/publish-plugins.yml` in the GitHub environment `plugins` with the `NPM_TOKEN`
  secret and `id-token: write`. It downloads exactly the attached tarballs, checks them again, and
  publishes plugin-api first, then each plugin, with `--provenance --access public`, dist-tag
  `latest` (or `next` for a pre-release tag). A version already on npm is skipped, so a rerun is
  safe. The published versions are appended to the release notes. Nothing publishes from a branch
  or a pull request.

## Rationale

One package per plugin lets a user download only the database they use, and npm gives us a
content-addressed CDN, sha512 integrity, provenance and mirrors that corporate networks already
allow, with no server of our own.

Lockstep versions make "which plugin goes with this app" a non-question for support: the plugin
shipped with a release is the one tested with it. A plugin-only fix ships as an app patch release.
Compatibility across versions is still decided by `tableCraft.apiVersion` (decision 106), so an
older app keeps installing the newest plugin it accepts.

Publishing what the draft release carries, rather than rebuilding at publish time, means the bytes
on npm are the bytes CI checked; publishing on `release: published` rather than on the tag keeps
the human review of the draft as the gate.

## Consequences

**Before the first publishing tag** the npm organisation `table-craft` must exist, and the GitHub
environment `plugins` needs `NPM_TOKEN` (a granular token limited to `@tablecraft-app/*`), a
deployment rule for `v*` tags and, optionally, a required reviewer.

**The first release after plan 057 must publish `@tablecraft-app/plugin-postgres`** before users
update, or the upgrade auto-install has nothing to fetch. Publishing the draft publishes both; the
auto-install retries every start.

**A branch build is versioned `0.0.0-dev.<sha>`.** Its manifest version is `0.0.0`, since the
manifest schema takes `X.Y.Z` only; nothing from a branch is published.

**The npm scope is `@tablecraft-app`.** `@table-craft` and `@tablecraft` on npm belong to other
projects, which the first publish found (E404 on every PUT). The workspace packages keep their
`@table-craft/*` names for imports; `OFFICIAL_SCOPE` in `pluginStore/catalog.ts` names the
published plugins, and the plugin-api build writes `PUBLISHED_NAME` and rewrites its self-imports.
