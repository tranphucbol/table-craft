# etcd

The etcd plugin connects to etcd 3.5 or later and [downloads the first time you add an etcd data
source](plugins.md#databases-in-the-box-and-on-demand). List one or more **Endpoints** (`host:port`, one
per line); TableCraft checks that they belong to the same cluster and uses only those, never the
addresses the cluster advertises, so an SSH tunnel or TLS name stays in force for each. Sign in
with a user and password, a client certificate (TLS client CN), or neither. A **Namespace** shows
only the keys under a prefix; it is a view, not a permission, and leases, users, roles and
maintenance still act on the whole cluster, which the app says each time. With **Read mode**
Serializable, the member you reach answers alone, and results are marked as possibly stale.

- **Key tree.** Keys in folders split on `/`, listed from the server 500 at a time per folder, with
  counts as folders scroll into view and a lease's time to live beside its key. Filter by prefix,
  by range, by name among the loaded keys, or to leased keys only. Deleting a key or a folder
  previews the keys first and fails if any of them changed since; a whole-keyspace or very large
  delete asks you to type the prefix.
- **Key editor.** One value per key, read as Text, JSON, YAML, Hex or Base64, with its version,
  create and mod revisions and lease in Key Details (`⌘I`). Submit writes one guarded transaction;
  if another client changed the key since you read it, **Merge** shows theirs, yours and the
  result side by side. **History** lists the key's earlier versions, diffs any of them against the
  current value and stages one with **Restore**. etcd keeps no dates, so ages count in revisions,
  and versions removed by compaction are named as missing, never hidden.
- **Leases.** Keep, detach or attach a key's lease in the editor, or grant one there. The Leases
  view lists every lease with its time to live and keys, and grants, renews and revokes them;
  revoking deletes every attached key, outside the namespace too, and the preview counts them.
- **Watch.** Follow a key, prefix or range from now or from a past revision. The pane shows events
  as they arrive, reconnects on its own and marks any gap (compaction, overflow). **Export Retained
  Events** saves what it kept as JSON Lines.
- **Server tab.** Members with the leader and learners, endpoint status and alarms; promote or
  remove a member, compact, defragment, take a snapshot (checksummed before it is saved) and check
  that the members agree.
- **Users & Roles.** Add and remove users and roles, grant permissions on keys and prefixes, and
  turn authentication off. Passwords go in a prompt that never stores or logs them. Turn
  authentication on with `etcdctl`, then reconnect.
- **Locks and elections.** A read-only view of who holds and who waits for the locks and
  elections under the prefixes you configure.
- **Console.** `etcdctl`-shaped `get`, `put`, `del`, `txn`, `lease`, `member`, `endpoint`,
  `alarm`, `compaction`, `defrag`, `user`, `role` and `auth`, with completion. `user add` and
  `user passwd` open the password prompt and leave nothing in history; `watch`,
  `lease keep-alive` and snapshot open their view instead of running. **Txn** opens a visual
  builder of compares and Then/Else operations, nested transactions included, kept in step with
  the console text.
- **Import and export.** Export a key range to a file at one revision and import one back; an
  interrupted run resumes after the last confirmed chunk. Files are chosen in the system dialog
  and never overwrite an existing one.

See [decision 136](../decisions/136-etcd-is-one-string-keyspace-guarded-by-revisions.md) and
[decision 139](../decisions/139-etcd-endpoints-are-the-configured-set.md).
