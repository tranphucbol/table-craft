# 144: The key tree loads on demand as a host option

Status: Accepted

## Decision

A key-value datasource can be set to **Load keys only when asked**: `loadKeysOnDemand: true` on
the datasource in `datasources.json`, beside `readOnly` and `enforceTimeoutOnServer`. The Data
Sources dialog shows it in Options, as the **Key tree** row, for every plugin that declares
`keyValue`. Absent, the tree loads as before.

With it on, connecting or expanding the datasource lists the databases and their key counts and
expands the configured one, but reads no keys. An unloaded database shows its filter row and one
row that starts its first pass: `Not scanned · ~48,213 keys · Scan` for a flat keyspace,
`Not listed · ~1,204 keys · List` for one that declares server-side children. Applying a filter,
Load more and Synchronize of a database already loaded still read keys. Go to Key opens a key it
finds by name and otherwise says so, without falling back to a partial-name filter.

The renderer alone decides when to load; no plugin-api field, no engine message, no
`API_VERSION` change.

## Rationale

On a large production Redis, the automatic first pass is up to 10,000 keys of `SCAN` per primary
on every connect, and much more when a filter matches few keys; on etcd, a root with many children
is hundreds of range reads. Teams that keep heavy reads off production stopped expanding the tree.

A connection field in each plugin (`scanOnOpen` in the Redis and etcd manifests) is the obvious
alternative. It fails twice: the renderer must not branch on a plugin's field keys (decision 007),
so it could not read the field; and the behaviour lives entirely in the renderer's key store,
which every `keyValue` plugin shares. A host option reaches every such plugin at once, the way
`readOnly` does.

An app-wide setting was rejected: the cost belongs to one server, not to the user, and the same
user keeps a local Redis that should load on open.

## Consequences

- On demand is not "never": Scan or List, a filter, Load more, expanding an etcd folder,
  Synchronize of a loaded database, Delete Keys Under Folder, console key completion and agents'
  `scan_keys` still read keys, each because the user asked.
- The database count still runs on connect (`INFO keyspace`, etcd's `count_only`): the row needs
  the estimate, and neither reads keys or values.
- A key opened from the console shows above the Scan or List row without loading the database.
- Go to Key loses its partial-name search on these datasources; an unanchored `MATCH` is the
  costliest scan there is.
