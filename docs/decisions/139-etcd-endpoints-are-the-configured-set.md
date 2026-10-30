# 139: etcd endpoints are the configured set; sent mutations are never replayed

Status: Accepted

## Decision

- **The configured endpoints are the whole transport.** An etcd data source lists one or more
  `host:port` endpoints (the legacy `host`/`port` is one). Through SSH, core opens one
  reference-counted tunnel per configured endpoint and passes authoritative
  `ConnectOptions.transports` (loopback address plus the original name for TLS SNI) through the
  optional `connectionEndpoints` hook. A missing or duplicate transport fails closed; there is no
  fallback to the configured address. Addresses a cluster advertises are shown but never dialled,
  and auto-sync, when on, only re-probes the configured set and re-checks the cluster ID.
- **One cluster or none.** Each endpoint is probed alone; every reachable one must report the same
  non-zero cluster ID, or the connection fails. Unreachable endpoints are listed as such, and
  member maintenance and snapshots pin a configured, admitted endpoint.
- **Sent mutations are never replayed.** A call picks one endpoint. A transport failure after the
  request left (unavailable, deadline, reset) becomes `statementFailed` with an unknown outcome,
  not `connectionLost`; only a failure detected before sending is `connectionLost`. The UI offers
  inspect and reload, never retry. The one exception is a stale auth token, rejected by the server
  before it acts, which rebuilds the client and retries once.
- **The namespace is mapped on every raw path, and global stays global.** A data source's
  namespace prefix is added to and stripped from every raw KV, Txn, history, completion, Watch,
  delete and transfer key. Leases, users, roles, permission ranges, compaction, defragment, alarms
  and snapshots act on the whole cluster; the UI says so and confirms them as global. The namespace
  is a view, not an authorization boundary.

## Rationale

`etcd3`'s `hosts` list is a randomized pool that retries elsewhere, and member discovery would dial
addresses that bypass the user's SSH tunnel and TLS identity. A write that timed out may have
committed, so replaying it could apply it twice; telling the user the outcome is unknown is the
only honest answer. `etcd3`'s `namespace()` wraps only its high-level builders, so the raw clients
the plugin uses (decision 136) would silently read and write outside the namespace unless every
path maps keys itself.

## Consequences

- An endpoint unreachable at connect is not admitted later; reconnecting expands the pool.
- Revoking a lease can delete keys outside the namespace; the preview counts them, but etcd cannot
  freeze attachments, so a key attached concurrently can still go.
- Enabling auth is refused in the app, since a configured password cannot be verified while auth
  is off; enable it with `etcdctl` and reconnect. Disabling is supported.
