# 072: Certificate files are paths the plugin reads on connect

Status: Accepted

## Decision

A data source can verify its server's certificate and sign in with a client certificate (plan 037).

- A plugin names its SSL fields with `connection.tls: { mode, verifyModes, caFile?, certFile?,
keyFile?, keyPassphrase? }` in its manifest, like `connection.network` (decision 070). The schema
  refuses a key the form does not declare, a `mode` that is not a select offering every value in
  `verifyModes`, a file that is not of kind `file`, and a passphrase that is not a secret password.
  The Data Sources dialog draws these fields under an **SSL** heading in the SSH/SSL section and
  branches on `tls`, never on a plugin id (decision 007).
- `datasources.json` keeps the paths, never the files' contents. The plugin reads them on every
  connect, expanding a leading `~`. A file it cannot read, a certificate that does not parse or a
  key it cannot decrypt fails `connectionFailed` naming the field's label and the path.
- The key passphrase is an ordinary manifest secret (`sslKeyPassphrase`), not a dotted key like
  `ssh.passphrase`: it is a plugin field and follows its save mode (decision 020). Main keeps it only
  while a key file is named, and connect asks for it only when that file is encrypted.
- Modes are `disable`, `require`, `verify-ca` and `verify-full`. `require` encrypts without checking
  the certificate even when a CA file is set; the dialog then says "Use Verify CA or Verify full to
  check this CA file." `verify-ca` checks the chain against the CA file (the system's CAs when
  none); `verify-full` also checks the host name. There is no `prefer`.
- A session reports `tls: { protocol, cipher }`, or `null` when unencrypted, and Test Connection
  shows it. A failure the SSL settings can fix is a `TlsSettingsError` (a `connectionFailed`), so the
  engine's hint points at those settings instead of the host and password. `@table-craft/plugin-api`
  holds the shared wording (`tlsFailureMessage`, `tlsFileMessage`, `tlsKeyMessage`) so every plugin
  names the CA file or host the same way.

## Rationale

Paths, not contents: a renewed certificate takes effect on the next connect without editing the data
source, the file stays where the user's tooling keeps it, and a private key never lands in
`datasources.json` or the secrets file. DataGrip, TablePro, `psql` and `mysql` all keep paths.

The plugin, not core, reads the files because each driver takes them differently (`pg` a Node TLS
options object, `mysql2` its own `ssl` object) and only the driver knows when the handshake happens.
The plugin API depends on zod alone (decision 004), so the shared part is
pure wording and classification; the `fs` and `tls` code lives in each plugin's `tls.ts`.

libpq's `require` turns into `verify-ca` when a root certificate is present. TableCraft keeps the
mode the user chose and says so in the dialog instead, so the mode list means the same thing for
every plugin and a stray CA file never makes a working connection fail.

## Consequences

- Plugin API 0.25.0: `connection.tls`, `Session.tls`, `TlsSettingsError` and the TLS helpers are
  new; a plugin built for 0.24 must be rebuilt, as for any 0.x minor.
- DataGrip and TablePro imports carry the CA, client certificate and client key paths, and map
  Verify CA to `verify-ca` (amending decision 067's "certificate files are not imported").
- A password-less certificate user still meets the password prompt: an empty secret is never stored.
- CRLs, OCSP, cipher or protocol pinning, and certificates in the OS keychain are out of scope.
