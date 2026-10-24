# 070: SSH tunnels live in core, behind the manifest's network fields

Status: Accepted

## Decision

A data source can reach its database through an SSH bastion (plan 036). The tunnel is
`@table-craft/core`'s (`packages/core/src/tunnels/`), built on `ssh2`; no plugin knows it exists.

- A plugin opts in with `connection.network: { host, port, connectTimeout? }` in its manifest,
  naming its own form fields (a text host, a number port, a number of seconds). The manifest
  schema refuses a name the form does not declare or a field of the wrong kind. PostgreSQL and
  MySQL declare it; SQLite does not, and the Data Sources dialog shows no SSH section for it. The
  dialog branches on `network`, never on a plugin id (decision 007).
- `datasources.json` keeps `ssh: { enabled, host, port, user, auth, keyPath }` beside `config`,
  with `auth` one of `password`, `key`, `agent`. The SSH password and the key passphrase are
  secrets under the keys `ssh.password` and `ssh.passphrase`: the dot keeps them apart from any
  manifest field key, and they follow the save modes of decision 020.
- Each engine host has one connector (`createConnector`). With a tunnel it opens one SSH
  connection for the data source and shares it among every session, counting them; the last session
  to close takes it down. Before `plugin.connect` it writes `127.0.0.1` and the forwarded port into
  the fields `network` names. Each database socket is one `direct-tcpip` channel to the host and
  port as the bastion resolves them.
- When the SSH connection drops, every call on a tunneled session fails `sshTunnelLost`. The
  console abandons that session (decision 054), so the next statement reconnects, which opens a
  new tunnel first.
- The connect timeout applies to each hop: the SSH handshake gets the plugin's `connectTimeout`,
  and the database connect inside the tunnel gets it again. Test Connection reports both hops.
- A connection URL never carries SSH; pasting one leaves the SSH section as it was.

## Rationale

The tunnel has to sit below every session the engine opens (consoles, introspection, export, the
probe connection, reconnect) and above every plugin. `connectDatasource` in the engine is already
that funnel, and core is where the engine's Node-side machinery lives, so a connector in core keeps
the renderer fence (decision 002) and leaves plugins unchanged. Putting SSH in each plugin would
repeat it per driver and leave a third-party plugin without it.

`ssh2` is pure JavaScript with optional native speedups (`cpu-features`, `sshcrypto.node`) it loads
inside `try`. The engine and main bundles stub both, so the packaged app ships no native code for
SSH and the ciphers run in JavaScript.

Typed errors (`sshAuthFailed`, `sshHostUnreachable`, `sshHostKeyChanged`, `sshHostKeyUnknown`,
`sshTunnelLost`) tell the user which hop failed. A forward the bastion refuses is remembered and
named in the database hop's error, because the driver alone would only see a closed socket.

## Consequences

- Plugin API 0.22.0: `connection.network` is optional, so older manifests still load and simply
  offer no tunnel.
- Jump hosts, `~/.ssh/config` aliases, keyboard-interactive or one-time-password sign-in, SOCKS
  and HTTP proxies, and dynamic forwarding are out of scope.
- SSL settings (plan 037) sit in the same SSH/SSL section of the dialog. TLS runs end to end
  inside the tunnel, but the plugin sees `127.0.0.1` as its host, so a check of the server
  certificate's name (`verify-full`) would compare against `127.0.0.1`; plan 037 has to hand the
  plugin the configured host as the TLS server name.
