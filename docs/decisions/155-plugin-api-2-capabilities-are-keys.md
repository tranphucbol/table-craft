# 155: Plugin API 2.0: a capability is a key, and installed plugins follow the app

Status: Accepted. Plugin API 2.0.0. Plan 151.

## Decision

Plugin API **2.0.0** regroups the optional members of a session and a language by capability. It is
the owner's major, taken once; decision 106 governs within 2.x. No shims, no deprecated aliases,
and no path that loads a 1.x plugin.

- **A capability is a key.** `Session.services` is an object keyed by capability, and each value is
  that capability's whole session-side part (`services.cancel` is `{ cancel(), reach }`,
  `services.sessions` holds `ownId` beside the monitor, `services.ddl` is the `DefinitionReader`
  that left `Introspector`). `SqlLanguage.services` is the same for the language-side part
  (`explain`, `currentNamespace`, `bulkInsert`, `objects`, `routineCall`, `savepoints`). Nothing a capability
  brings lives anywhere else. `Session` keeps only what every session has or what is a fact of the
  connection: `execute`, `close`, `serverVersion`, `serverBrand?`, `privateDatabase?`, `tls?`.
  `sql` and `commands` are `plugin.language` and `plugin.commandLanguage`; `explainAnalyze`,
  `serverMessages` and `revisions` are flags with no service.
- **Savepoints are a capability** (plan 152). `savepoints` brings `language.services.savepoints`;
  a dialect without savepoints, such as DuckDB, leaves it out, and console edits in its open
  transaction are refused instead of half undone. It was `SqlLanguage.savepoint`, required, before
  any stable release shipped 2.0.0.
- **Present exactly when declared, both ways.** The keys of `session.services` equal the declared
  session-side capabilities and the keys of `language.services` the language-side ones. A service
  is an object, never `null`: a fact about the server (no timeout setting) is a field inside it
  (`serverTimeout.limit`).
- **One function states the rule**: `serviceProblems(capabilities, plugin, session?)` in
  plugin-api. The loader runs it on the plugin and its language (a problem makes the plugin
  unavailable), `openSession` on every session it opens (a problem closes the session and fails
  with `pluginUnavailable`), and the contract suite on both, so the three cannot drift.
- **The types say it to authors.** `definePlugin` is generic in the declared capabilities and the
  connection schema: `connect` returns a `PluginSession<C>` whose `services` has exactly the
  declared keys, and `language` or `commandLanguage` is required exactly with `sql` or `commands`.
  The host keeps the plain names (`DatasourcePlugin`, `SqlLanguage`, `Session`) for any subset of
  services; authors write `PluginDefinition<C, S>`, `PluginLanguage<C>` and `PluginSession<C>`.
- **An outdated plugin is a missing plugin.** A managed catalog plugin from the registry that was
  built for an older major is installed again from the registry exactly as a missing one is: at
  launch for every saved data source's plugin, from the Install/Retry control, and before a connect
  that needs it. It does not wait for the update schedule or the automatic-check setting. The
  loader's `incompatibility` (`olderMajor`, `newer`) tells main and the renderer which side is old;
  a plugin in the user's folder or installed from a file stays unavailable with "Rebuild it for
  plugin API 2.x".
- **Every plugin of this repository moves together.** All seven manifests declare `2.0.0` and ship
  with the release that takes the major. The frozen SQLite 1.0.0 plugin becomes the refused older
  major, and a frozen 2.0.0 plugin beside it runs the contract (decision 107).

## Rationale

In 1.x a session had about 30 optional members and a language six more, and the rule "present
exactly when the plugin declares the capability" was prose in doc comments. The engine read about
60 of them four different ways (presence only, capability and presence, capability then a `typeof`
check, `?.` with a silent fallback), and failed four different ways when one was absent. A
capability's parts were scattered: on the flat session, on `Introspector`, on `SqlLanguage`, or
shared by two capabilities. Every new capability paid for this again.

Keeping 1.x compatible was what stopped the regrouping. Every plugin lives in this repository and is
published from it, so a major costs one coordinated release, while the flat shape costs every
capability after it.

A key per capability makes the rule data: one function checks it, the types narrow on it, and the
engine reaches a service through one gate (`engine/services.ts`) with one failure for "the plugin
does not declare this".

Installing an outdated plugin at once, rather than on the 2-hour schedule, follows from what an
older major is: it cannot run at all, so waiting only leaves a data source that does not open.

## Consequences

- Every 1.x plugin stops loading. The five optional ones update themselves; a hand-built one shows
  "Rebuild it for plugin API 2.x".
- A 1.x app keeps working: `pickVersion` only picks compatible versions, so it keeps its 1.x
  plugins.
- Between the app's release and the plugin packages' publish, an updated app finds no 2.0 plugin:
  the install fails, the data source shows Retry, and the next connect or launch tries again.
  `RELEASING.md` publishes the plugin packages before the app's update manifest for a major.
- The engine reads services only through `engine/services.ts`; an ESLint fence forbids `.services`
  elsewhere in `packages/desktop/src/engine/**` and `packages/core/src/**` (except the two core
  modules that open transactions). "The plugin cannot do that" reads "This datasource's plugin does
  not declare the `<capability>` capability."
- The contract suite's 26 presence assertions became one `serviceProblems` check.
- A new capability adds one key to `SessionServices` or `LanguageServices`, one entry in the
  capability names, and a gated contract block.
