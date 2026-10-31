# 136: etcd is one string keyspace over raw RPC, guarded by revisions, with history from Watch

Status: Accepted

## Decision

etcd ships as an optional plugin (`plugins/etcd`, downloaded on demand like Redis, decision 108)
built on the `etcd3` driver's raw gRPC clients (`kv`, `watchClient`, `leaseClient`,
`maintenance`, `auth`, `cluster`), not its high-level builders. It declares `commands` and
`keyValue`, so the key tree, key tab, console and Server tab are the Redis ones (decisions
112-113), plus the optional services of decision 137.

- **One database, string keys only.** The keyspace is one database (index 0). Every key is type
  `string` holding one value; the tree splits names on a configurable delimiter (`/`) and, on a
  datasource set to load keys only when asked, lists the root only on request (decision 144). Any edit
  other than `setString` is refused with a typed error. Binary keys and values travel as text plus
  hex.
- **Revision guards, not WATCH.** A key edit is one `Txn` guarded by a compare on the value, the
  mod revision or `create_revision == 0` for a new key; a failed compare returns the same
  `conflict` result as Redis (decision 115), and the key tab opens Merge in place. An existing
  key's lease is kept (`ignore_lease`) unless the user explicitly detaches or attaches one;
  lease-only changes use `ignore_value`. A prepared delete binds an exact range, namespace and
  revision and commits only if no key in it was created or modified since (`noNewOrModifiedKeys`),
  because `DeleteRange` cannot be pinned to a revision.
- **History is replayed from a historical Watch.** `revisions` reads a key's past versions by
  opening a Watch from revision 1 (or the cursor's next revision) up to the key's mod revision at
  the first page. Pages are bounded (100 events, 1 MiB, 5 s). The cursor is the page position,
  signed with an HMAC whose key is random per session and zeroed on close, so a renderer cannot
  forge or replay a position on another key or session. When the server reports a compaction,
  the page returns a `compacted` gap up to that revision and `complete: false`; it never presents
  partial history as complete. etcd keeps no timestamps, so ages are counted in revisions and no
  dates are shown or inferred. Restore stages the old bytes against the current revision and
  keeps the current lease; it never writes on its own.

## Rationale

etcd has no types, no `MULTI` and no row identity; its one consistency tool is the
compare-and-swap `Txn` over revisions, which is cheaper and stronger than re-reading values.
`etcd3`'s namespace and builder layers do not reach the raw clients and coerce 64-bit revisions
to `Number`, so the plugin works on the raw RPCs and keeps every revision, lease and ID as a
decimal string. etcd has no "key history" RPC; a Watch from an old revision is the only way to
replay one key's events, and compaction can remove any prefix of them at any time, so the gap
must be visible rather than silently skipped. A stateless signed cursor lets the plugin page
without keeping searches alive.

## Consequences

- Hash, list, set, sorted-set and stream fixtures are optional in the keyspace contract suite
  (API 1.8.0, additive).
- A key created before the compaction point says its earlier versions are gone. Tests that
  compact use a disposable server (`test/support/etcdIsolated.ts`), never a shared one.
- An absent key has no terminal event, so its history can stop at the deadline without claiming
  completion.
- A history cursor dies with its session; the UI starts a new search after a reconnect.
