# 149: An engine runs before its datasource connects

Status: Proposed. Amends 002.

## Decision

A datasource's engine can run without the datasource being connected. "Engine running" (the
`utilityProcess` with the plugin loaded) and "connected" (a verified login) are separate states;
the Database tree and the status bar show only the second.

- The renderer asks for an engine port in one of two modes (`EngineConnectMode`). `session`, the
  default, is a login as before: main answers `needsSecrets` until it has every secret. `language`
  is for calls that need only the plugin, such as `sql.format`: main starts the engine with the
  secrets it has, never answers `needsSecrets`, and records the host as partial when one is
  missing.
- `useDatasources.engine(id)` gets a `language` client without `session.open` and leaves the
  connection status alone. Reformat Code uses it; everything that reads the server still uses
  `connect(id)`.
- `connect(id)` on a datasource whose engine a `language` request started reuses that engine and
  its port. It asks main to authorize the engine (`authorizeEngine`): main computes the missing
  secrets as a connect does, answers `needsSecrets` until they are typed, then posts
  `engine.credentials` with the whole `DatasourceConfig` on the engine's parent port and waits for
  `engine.credentials-applied`. Only then does the renderer verify the login.
- The engine swaps the connector its sessions open through; sessions already open keep their
  login and their tunnel. A config naming another datasource or plugin is refused.
- Main shares a running host with a `session` connect, a window's or an agent's, only once it is
  complete; a partial one is authorized first, or the connect answers `needsSecrets`.
- Typed secrets are kept only after a verified login, as before. A login that fails still stops
  the engine. An engine that exits while its datasource is neither connected nor connecting
  changes nothing the user sees.

## Rationale

Formatting is pure: the engine answers `sql.format` from the plugin's `language`, and sessions
open lazily (decision 022). Yet Reformat Code went through `connect`, so on a disconnected
datasource it logged in, flipped the tree to Connected, raised the password prompt, and failed
outright when the server was unreachable.

Skipping the login in the renderer alone still left main's prompt, because main started an engine
only with every secret baked into its boot config. Restarting the engine with the secrets on the
real Connect would close the renderer's port under any in-flight call and look like a crash to
`engineExited`; a separate per-plugin language engine would be a third process kind and load the
plugin twice. Handing the secrets to the running engine keeps one process and one port per
datasource.

A separate `authorizeEngine` call, rather than a second `session` port, keeps one client per
datasource in the renderer, and the acknowledgement orders the credentials before the renderer's
`session.open`, which travels on a different channel.

## Consequences

- Reformat Code on a disconnected datasource no longer connects it. Someone who used it as a cheap
  Connect loses that; the Connect action is unchanged.
- An engine process can run behind a Disconnected datasource: no session, no socket, only memory.
  It stops when the app quits, the datasource is edited or deleted, or a Connect/Disconnect cycle
  stops it. There is no idle timeout.
- Not every running engine holds every secret any more, so `service.connect` checks completeness
  before sharing one. An agent's connect to a partial host without stored secrets fails as it
  does when no engine runs.
- Main → engine gains `engine.credentials` and its acknowledgement; renderer → main gains a mode on
  `connectEngine` and the `authorizeEngine` channel. The renderer ↔ engine protocol and the plugin
  contract are unchanged.
- Completion, signature hints, `sql.explainable` and `table.orderBy` still connect: they read the
  catalog or run next. MCP `format_sql` could move to `language` mode later.
