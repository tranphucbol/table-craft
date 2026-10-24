# 073: A tunneled connection checks the configured host's name

Status: Accepted

## Decision

`ConnectOptions` gains `serverName?: string`. When the connector (decision 070) rewrites a data
source's host to `127.0.0.1` for an SSH tunnel, it passes the configured host as `serverName`. A
plugin that verifies host names checks the server certificate against `serverName ?? host`:

- PostgreSQL gives `pg` a `checkServerIdentity` that checks against that name, and sets SNI
  (`servername`) to it unless it is an IP address.
- MySQL hands `mysql2` the name as its `host` and a socket it opened itself (`stream`) to the real
  address, keeping `mysql2`'s keepalive and no-delay settings, because `mysql2` checks identity and
  sends SNI from `host` alone. `verify-full` also turns on `verifyIdentity`, which it lacked before.

The cancel and kill connections a session opens use the same name.

## Rationale

TLS runs end to end inside the tunnel, so the certificate is the database's, issued for its real
name; checking it against `127.0.0.1` would fail every `verify-full` connection through a bastion.
Telling the plugin the name keeps the tunnel in core and the TLS in the plugin, and a plugin that
ignores the option still works for every mode except `verify-full` behind a tunnel.

Rewriting the certificate check in core would need core to own the driver's socket, which it does
not.

## Consequences

- A third-party plugin that verifies host names should honour `serverName`.
- `mysql2` falls back to the socket's address when its `host` is an IP address, so a tunnel to a
  data source configured by IP checks `127.0.0.1`; such a server's certificate rarely names the IP
  anyway, and Verify CA covers it.
- `mysql2` resumes TLS sessions from a cache keyed by host and port and skips the identity check on
  a resumed session; the check still runs on the first connection of each process.
