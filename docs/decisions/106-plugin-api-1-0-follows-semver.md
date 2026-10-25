# 106: Plugin API 1.0 follows semver

Status: Accepted. Plugin API 1.0.0.

## Decision

`@table-craft/plugin-api` is `1.0.0` and stays backward compatible within a major.

- **Loading.** A host on plugin API `1.z` loads a plugin whose manifest `apiVersion` is `1.y` when
  `y ≤ z`, whatever the patch. It refuses a newer minor ("needs TableCraft with plugin API 1.4 or
  later; this TableCraft provides 1.0.0. Update the app.") and another major ("an older major than
  this TableCraft's 1.0.0. Install a version of the plugin built for plugin API 1.x."). The reason
  reaches the log and the Data Sources kind picker, like every other unavailable plugin
  (`incompatibility` in `version.ts`, `incompatibleReason` in the loader).
- **`apiVersion` is the API the plugin was built against**, not the oldest it tolerates.
- **A minor only adds:** new exports, new optional fields and methods, new capabilities, new
  contract tests gated on a capability or fixture field. A fix with no surface change is a patch.
- **Breaking, so a major and the user's say-so:** removing or renaming an export, field, method or
  capability; making an optional field or parameter required; adding a required member to a type
  the plugin implements or returns; widening a type the plugin receives (a new member of a
  host→plugin union such as `StatementKind` or `ObjectKind`) unless the plugin opts in through a
  capability or a feature flag, as `ObjectFeatures` does; narrowing a type the plugin returns;
  changing what an existing field means.
- **Deprecate, then remove.** A member to go gets `@deprecated` naming its replacement and keeps
  working until the next major.
- **No version sniffing.** The host calls a new optional method only when the plugin has it or
  declares its capability, never because of `apiVersion`.

## Rationale

The user ruled (2026-10-25) that the plugin API stays backward compatible from now on, except for
an explicit breaking change, and that plugins are published to npm (plan 057). Under 0.x the loader
accepted only the exact minor, and every plan bumped it, so every release broke every user plugin
and an on-demand plugin could not survive an app update.

The direction of a type change decides whether an old plugin survives it: what the plugin receives
may narrow and what it returns may widen, because the old code already handles the subset or
produces a member of the superset. The opposite directions break it, which is why a new value of
an enum the plugin switches on needs an opt-in.

## Consequences

**This changes the plugin contract.** `API_VERSION` goes from `0.28.0` to `1.0.0` and the built-in
manifests with it. Plugins built for 0.x are another major and stop loading until rebuilt; this
happens once.

**Merges stop bumping the minor by default.** A plan takes the next minor only when
`bun run api:check` (decision 107) reports an addition since the last release tag and main does not
already hold that minor; a plan with no surface change takes none; a major never without the user.

**Host→plugin enums are frozen without a flag.** Adding a `StatementKind`, `ObjectKind`,
`TransactionMode`, `KeywordCase`, `FormatStyle`, `ParameterStyle`, `GeneratedStatement` or
`ImportKind` needs a capability or feature flag the plugin sets, or waits for 2.0.
