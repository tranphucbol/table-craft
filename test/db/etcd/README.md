# Test-only etcd transport fixtures

`etcd-tls` requires client certificates signed by `../tls/ca.crt`. Tests reuse
`../tls/client.crt`, its plain/encrypted keys and the bastion's pinned host key.
There is no etcd username/password authentication on this isolated server.

`server.crt` is the test-only, self-signed server trust anchor; `server.key` is
deliberately public test material. `sh test/db/etcd/generate-tls.sh` regenerates
only these two files. The shared CA's signing key was discarded, so this server
uses a separate anchor instead of rotating certificates used by other suites.
Its SANs name `localhost` and `etcd-tls`, not an IP: a verify-full connection
forwarded to loopback must retain the original hostname for TLS verification/SNI.

The etcd profile starts this server on `TABLE_CRAFT_ETCD_TLS_PORT` (default 52381),
the SSH bastion and a seeder that writes only `/seed/probe`. Hash labels track
server/client certificates, keys and the seed script; healthchecks verify mTLS.
The sentinel check reads `/seed/probe` over verified HTTPS with the client cert.
Transport tests only read that key; they never compact or change shared keys.

## Disposable advanced-operation fixtures

`test/support/etcdIsolated.ts` exports `withIsolatedEtcd(options, async fixture => …)`.
Options select `version: "3.5" | "3.6"` (default 3.6), `members: 1 | 3` (default 1),
`auth: boolean` (default false), and `quotaBytes` (2–64 MiB, default 64 MiB).
Pre-pull the pinned images when needed:

```
docker pull gcr.io/etcd-development/etcd:v3.5.21
docker pull gcr.io/etcd-development/etcd:v3.6.5
```

Every invocation creates UUID-named containers, a dedicated bridge network, and
RAM-backed local-driver volumes. A separate, unpublished keeper container holds
the volumes mounted: ordinary container tmpfs would lose member data on restart.
The keeper's own etcd is unrelated to the test cluster and listens only on its
loopback. This needs a local Linux Docker daemon (including Docker Desktop), not
a remote Docker context. No bind mounts, shared compose resources, environment
database endpoints or persistent database directories are used.

Members publish distinct random loopback host ports. Ports are reserved until
just before each member starts; a competing process can still win that brief
handoff, in which case setup fails and cleans up rather than choosing a shared
endpoint. Advertised client URLs are these host-accessible endpoints; advertised
peer URLs use container DNS on the dedicated network, never container loopback.
`plan.members[index].internalEndpoint` is the corresponding container-network
client URL. Host clients must use `endpoint`, not the internal DNS names. Clients
are pinned explicitly and do not discover/auto-sync endpoints.
Container CLI calls must likewise stay pinned: do not use `etcdctl --cluster`,
which would discover host-loopback client advertisements from inside a container.

The fixture exposes a direct `etcd3` `client`, `raw(memberIndex = 0, auth?)` for
additional pinned clients, and `ctl(memberIndex, args, auth?)` for image-provided
`etcdctl` (no shell required). Auth defaults to the fixture root when enabled;
pass `null` for anonymous access or `fixture.credentials.limited` for a user with
read permission only under `/app/`. Bootstrap creates both users before enabling
auth. All raw clients returned by the helper are closed automatically.

`stop(index)`, `start(index)` and `restart(index)` retain member data and published
ports. They do not wait for quorum: call `waitReady()` after restoring all members.
`waitReady()` checks every member's health and requires quorum. Tests may use the
raw client for lease expiry/renewal, watches, compaction, auth mutations, member
maintenance, snapshot streams/HashKV and namespaced bulk fixtures without any
plugin API assumptions. Test-owned streams/leases and any external plugin sessions
must still be closed by the callback. Snapshot files written by image CLI should
stay in the RAM-backed data directory; nothing copies them onto the host.

Cleanup attempts every container, then every volume, then the network even after
partial setup or callback failure; cleanup errors are reported with the original
failure. SIGKILL/daemon failure can still leave UUID-named resources behind. Never
use global prune for recovery; remove only the exact resources from that run.
The CLI wrapper rejects endpoint override flags, but is test infrastructure, not
a security sandbox for untrusted command arguments.

`test/db/etcdAdvancedFixture.test.ts` contains pure planning/cleanup-command
self-tests; it starts no Docker processes and does not depend on etcd selection.
The validation owner can run it with:

```
TABLE_CRAFT_DATABASES=etcd bunx vitest run --config vitest.db.config.ts test/db/etcdAdvancedFixture.test.ts
```

No live fixture tests or runtime capability tests are included in that file.
