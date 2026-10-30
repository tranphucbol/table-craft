# 136: Advanced key-value services are optional capabilities in API 1.8.0

Status: Accepted

## Decision

What etcd needs beyond `keyValue` enters the plugin API (`packages/plugin-api/src/keyAdvanced.ts`)
as optional session services, each gated by a capability the plugin declares:

| Capability     | Service                       | What the host does with it                                     |
| -------------- | ----------------------------- | -------------------------------------------------------------- |
| `revisions`    | `keyspace.history`            | the key tab's History, diff, Restore and Merge                 |
| `watch`        | `watch` (`KeyWatcher`)        | the Watch pane: live events, reconnect gaps, JSON Lines export |
| `leases`       | `leases` (`LeaseManager`)     | the Leases view and the key editor's lease controls            |
| `members`      | `cluster` (`ClusterManager`)  | the Server tab's Members view                                  |
| `maintenance`  | `cluster`                     | alarms, compact, defragment, snapshot, consistency check       |
| `access`       | `access` (`AccessManager`)    | Users & Roles                                                  |
| `coordination` | `coordination`                | the read-only lock and election viewer                         |
| `bulkTransfer` | `keyTransfer` (`KeyTransfer`) | resumable export and import of a key range                     |

Alongside them, also optional: `KeyDetails.attributes`, `CommandLanguage.admit` with its
admissions and intents (decision 137), `connectionEndpoints` and `ConnectOptions.transports`
(decision 138). After rebasing onto released API 1.7.0, these additive changes take the next minor,
`API_VERSION` 1.8.0; none takes a version of its own.

The shapes share rules: revisions, lease and member IDs, TTLs, sizes and unbounded counts are
decimal strings; `null` means unknown, never zero; page and operation budgets are bounded numbers.
A `KeyRange` is `key`, `prefix`, `range` (exclusive end) or `all`, relative to the namespace.
Streams, renewing leases and long tasks own dedicated sessions, never the shared helper queue or
a console session, and close on stop, disconnect, port disposal and shutdown. No mutation is
retried automatically; an uncertain outcome is reported as uncertain. The engine reaches each
service through strict-schema calls (`protocol/keyAdvancedCalls.ts`) and never takes a datasource
ID from the renderer.

## Rationale

Decision 106 allows only additive changes within a major, and decision 007 forbids the UI from
branching on plugin IDs. Optional services behind capabilities let the renderer show a Leases view
or a Watch pane for any store that can answer them, while Redis and SQL plugins stay untouched.
Decimal strings are required because etcd's int64 revisions and lease IDs do not fit a JavaScript
number. Leases, Watch and administration cross process and data-loss boundaries, so bounds,
dedicated resources and no-replay rules are part of the contract rather than plugin folklore.

## Consequences

- Contract tests run only for the capabilities a plugin declares; the API reports in
  `packages/plugin-api/api/` record the additions, and `bun run api:check` passes on 1.8.0.
- Keepalive stop closes renewal only; it never revokes a lease. Revoking is global and can delete
  keys outside the namespace, which the UI always says.
- Coordination is a viewer over configured prefixes, not a lock or election client.
- Watch keeps a byte- and event-bounded ring in the engine; overflow, compaction and oversized
  events surface as explicit gaps, and the checkpoint advances only after a whole revision.
- Snapshot and transfer files go only through host file grants (decision 137).
