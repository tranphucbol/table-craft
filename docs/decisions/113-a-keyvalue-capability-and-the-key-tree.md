# 113: A `keyValue` capability and the key tree

Status: Accepted

## Decision

A `commands` plugin may declare `keyValue` and give each session a `keyspace`: `databases()`,
`scan()`, `describe()`, `read()`, `preview()`, `apply()`, `rename()`, `expire()` and `remove()`
(`packages/plugin-api/src/keyspace.ts`). The Database pane draws a datasource that declares it as
a key tree instead of the catalog tree; the two never mix in one datasource.

- **Databases.** Standalone Redis shows one node per non-empty database plus the configured one;
  Show Empty Databases (`explorer.toggleEmptyDatabases`) shows the rest. A cluster shows one
  `db0` and a **Cluster nodes** group.
- **Scanning, never `KEYS`.** The tree scans in batches of the datasource's SCAN batch and stops
  at 10,000 keys per pass with a `Scanned 10,000 of ~48,213 · Load more` row; the estimate is the
  server's key count. The cursor is opaque to the host; in a cluster the plugin encodes the
  primary it is scanning. A filter row takes a `MATCH` glob and a type and rescans. A datasource
  set to load keys only when asked starts no pass until the user does (decision 144).
- **Folders** come from the delimiter the plugin reports (`:` by default), counted over loaded
  keys only. Types and TTLs are described for visible rows only, in batches.
- **Key names are bytes.** A key crosses as `{ text, hex }`: `text` decodes UTF-8 with invalid
  bytes as `\xNN`, `hex` is set when the name is not valid UTF-8, and every operation sends the
  hex back when present.
- **A key opens in a key tab.** `keyspace.open` runs `read()` and puts its rows in the engine's
  result store, so the grid, sort, find, copy, export and the value panel work unchanged.
  Columns follow the type; a string opens a value editor with formats (Auto, Text, JSON, Hex,
  Base64, MessagePack, gzip) remembered per key pattern in the layout.
- Search Everywhere gains a **Keys** tab over loaded keys; Go to Key… opens an exact name or
  filters the tree by `*query*`.

## Rationale

The catalog model (namespaces, relations, columns) does not fit a flat keyspace of millions of
keys, and walking it with `KEYS` blocks the server. A separate tree fed by bounded scans keeps
the explorer responsive on any size and never surprises an operator with a blocking command.
Reusing the result store for key contents keeps rows in the engine (decision 009) and gives a
key tab every grid feature for free.

## Consequences

- The tree is a sample, not an inventory: folder counts are of loaded keys, and Load more or a
  filter is the way to the rest.
- Key tabs are not restored at launch.
- MongoDB (plan 059) will need its own tree shape; `keyValue` stays specific to key-value stores.
