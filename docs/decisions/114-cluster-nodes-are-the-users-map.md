# 114: Commands and server figures may target a node; cluster reachability is the user's map

Status: Accepted. Amended by 142.

## Decision

A plugin may declare `nodes`: `Session.nodes()` lists `{ id, address, role, slots, primaryId,
state }`, and `ExecuteOptions.node` is `"auto"` (by key slot, keyless commands to a primary),
`"allPrimaries"`, or a node id. The console shows a **Run on** picker when there is more than one
node. With `allPrimaries` the answer is one result with a leading `node` column. In a cluster,
`DBSIZE`, `INFO`, `SCAN`, `KEYS`, `FLUSHDB`, `SLOWLOG GET`, `CLIENT LIST`, `CONFIG GET` and
`MEMORY STATS` default to every primary, since one node's answer would mislead. The plugin
routes commands itself (first key → its slot's primary; MOVED and ASK fall back to the
driver's cluster client), so the driver's response policies never sum or merge answers behind
the user's back.

Cluster nodes announce addresses the client may not reach (container or VPC addresses). The
datasource's **Node address map** holds `announced=reachable` pairs. At connect the plugin
probes every announced address through the map; a node it cannot reach fails the connect,
naming the announced address, the mapped one, and the hint to add it to the map.

A plugin that declares `serverInfo` answers `serverInfo(node)` (titled sections of figures, such
as Redis `INFO`) and `slowLog(node, limit)`. The **Server tab** (`server.show`, Server Info on the
datasource's menu) draws the sections as cards with a refresh interval, a node picker and a
cluster Overview of every node, and a Slow log view whose commands open in a console. A null
node means the server, or every primary for the slow log of a cluster.

**SSH tunnels are refused in cluster mode** (`connectionFailed`: an SSH tunnel reaches one node,
a cluster needs every node). The user maps each node through their own tunnels instead.

## Rationale

Guessing reachability (rewriting every address to the seed host, say) works on a laptop and
silently talks to the wrong node elsewhere. An explicit map is the only form that is right on
Docker, Kubernetes and cloud networks alike. Core opens one tunnel per datasource (decision
070); a tunnel per node would need a new tunnel model and is out of scope.

## Consequences

- A cluster behind a bastion needs the user's own port forwards and a map entry per node.
- `CROSSSLOT` errors carry the hint to wrap the common part of the keys in `{…}`.
- Reads go to primaries; picking a replica in Run on sends `READONLY` on that connection only.
