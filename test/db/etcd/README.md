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
