# 107: Plugin API compatibility is checked, not promised

Status: Accepted. Plugin API 1.0.0.

## Decision

Three checks hold decision 106, and the package becomes publishable.

- **A committed surface report.** `scripts/api-report/` prints the public types of each entry of
  `@table-craft/plugin-api` (`.`, `/sql`, `/testing`) into `packages/plugin-api/api/*.api.md`: one
  declaration per export, members one per line and sorted, types the entries reach without
  exporting as `~Name`, `/** @deprecated */` where marked, and `API_VERSION` in the header.
  `bun run api:report` writes them; `bun run api:check` fails when they differ from what the code
  produces, so every surface change shows in review.
- **A classification against the last release.** `api:check` reads the reports at the last
  reachable `v*` tag (`git describe --tags --abbrev=0 --match "v*"`) and classifies each change: a
  removed symbol or member, or a new required member, is breaking; a new symbol, a new optional
  member or a new `@deprecated` is an addition. A changed signature cannot be judged by text,
  since its direction decides, so it needs a verdict (`addition` or `breaking`, with a reason) in
  `packages/plugin-api/api/compatibility.json`; a verdict never softens a removal. An addition
  needs `API_VERSION` above the tag's minor; a breaking change needs a new major, which only the
  user takes. A tag without reports (every tag before the first release after plan 056) skips the
  classification with a note. `test/scripts/apiReport.test.ts` runs the same checks in
  `bun run test`; CI fetches tags (`fetch-depth: 0`) so the comparison runs there too.
- **A frozen plugin.** The SQLite plugin as built at 1.0.0 is committed as a bundle in
  `test/support/frozen-plugins/sqlite-1.0.0/` (`index.js` without its source map, and the
  manifest). `test/plugins/frozenSqlite.test.ts` loads it through the real loader and runs the
  current contract suite and a core round trip against it. It is rebuilt
  (`bun scripts/frozen-plugin.ts`) only when 1.0.0 itself changes before its release, never to make
  a failing run pass; a later major adds a second frozen plugin beside it.
- **A publishable package.** The workspace package stays `private` and exports TypeScript source,
  so the app and the plugins keep building from source. `bun run --cwd packages/plugin-api build`
  stages the publishable one in `packages/plugin-api/release/` (git-ignored): `tsc` output with
  declarations in `dist/`, a `package.json` whose exports point there, `files: ["dist"]`,
  `repository`, `publishConfig.access: public`, and version `API_VERSION`, plus its README and the
  repository's LICENSE. `test/plugin-api/package.test.ts` packs it (`npm pack --dry-run`) and
  imports it in plain Node. Publishing is plan 057's.

## Rationale

A promise nobody checks is broken by the first plan that forgets it. The report makes the surface
reviewable line by line; the classification makes the version follow the surface; the frozen
plugin catches what types cannot see, such as a new contract test an old plugin fails, a host that
starts calling a method an old plugin lacks, or a changed meaning.

`@microsoft/api-extractor` was the default candidate. It needs declarations on disk and a config
per entry, ships its own TypeScript, and writes a free-text report we would still have to parse to
classify. Our tool emits declarations in memory with the repository's TypeScript and prints a
format that is both the review artifact and the classifier's input, in about 2 seconds.

A frozen bundle (507 kB) beats rebuilding old source in every test run, which would need a git
ref and a Vite build each time.

The package version is `API_VERSION` rather than the app's: a plugin depends on
`@table-craft/plugin-api@^1.y` and declares `apiVersion: 1.y`, the same number in both places.
npm has no `publishConfig.exports`, so the staged `package.json` is written, not overlaid.

## Consequences

**`bun run test` now fails on an unreviewed surface change.** Run `bun run api:report`, commit the
reports, and bump `API_VERSION` (and the built-in manifests) when the check asks for it.

**New contract tests must pass the frozen plugin.** Gate them on the capability or fixture field
they test, or they are a breaking change.

**The first release after this plan carries the first reports.** Until then the classification is
skipped; the report diff in review is the only check.
