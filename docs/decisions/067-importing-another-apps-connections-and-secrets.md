# 067: Importing another app's connections and secrets

Status: Accepted.

## Decision

TableCraft imports data sources from DataGrip and TablePro by reading their files in main, never
writing or locking them, and maps each connection to a plugin by its URL scheme. Secrets follow
decision 020: main reads them, saves them through the secret store, and sends the renderer only a
password state.

- **DataGrip** (format learned from its files and IntelliJ Community, Apache-2.0,
  `platform/credential-store-impl`): connections from the global and project `dataSources.xml`,
  `dataSources.local.xml` winning per field. Passwords are where `options/security.xml` puts them:
  - The native store, by the service name `IntelliJ Platform DB — <uuid>`. On macOS TableCraft runs
    `/usr/bin/security find-generic-password -s <service> -g`, without a shell, one item at a time,
    only during the run and only when Import passwords is on, and reads the password from the
    `password:` line (`-w` prints a non-ASCII password as bare hex, which a hex-looking password
    makes ambiguous). Exit 44 is not found; 128 or 51 is a denial and stops every later lookup; 36
    is a locked keychain. On Linux it runs `secret-tool lookup service <service>` and splits
    IntelliJ's `user@password` value at the first unescaped `@`. Windows Credential Manager is not
    read.
  - KeePass `c.kdbx`, read at preview without asking anyone. IntelliJ writes KDBX 3.1: AES-256-CBC
    payload, AES-KDF with its rounds, hashed blocks, gzip, and protected values under ChaCha20 or
    Salsa20 (KeePass's KDBX 3.1 file format). The main key comes from `c.pwd` (or the older
    `pdb.pwd`) only when its `encryption` is `BUILT_IN`, IntelliJ's fixed AES-128-CBC key; any other
    main-key protection or KDBX version shows the passwords as locked.
- **TablePro**: `connections.json` (a JSON array of connections) and the groups in its
  `com.TablePro` defaults, read with `/usr/bin/defaults export`, carry no passwords; TablePro keeps
  them in keychain items of its own that TableCraft does not read. Its `.tablepro` export is JSON
  with connections, groups and, when the user includes them, credentials keyed by each
  connection's reference (by position in format 1). An encrypted export starts with `TPRO`, a
  version byte, a 32-byte salt and a 12-byte nonce, then AES-256-GCM ciphertext and its 16-byte
  tag, under a key PBKDF2-HMAC-SHA256 derives from the passphrase in 600,000 iterations. The
  passphrase is used once and never stored or logged.

Ciphers Electron's BoringSSL lacks (raw ChaCha20) and stream ciphers Node never had (Salsa20) are a
few dozen lines of JavaScript checked against RFC 8439 and eSTREAM vectors.

## Rationale

DataGrip and TablePro are the apps the users come from, and retyping a dozen connections with their
passwords is the first friction of a new client. Reading in main keeps the renderer fence and
decision 020 intact. Reading the files read-only means an import can never damage the other app.

One keychain item per lookup with Allow, not Always Allow, leaves DataGrip's items private to
DataGrip; stopping at the first denial respects a user who said no. TablePro's own items are left
alone because the encrypted export is the supported way out of TablePro and needs no keychain at
all.

TablePro is AGPL-3.0, so its formats are described here from observing its files and the shapes of
its export, not from its code. IntelliJ's formats come from its Apache-2.0 source.

## Consequences

- A DataGrip format change can make a connection unreadable; the scan then reports what it found
  and the rest still imports.
- A password DataGrip keeps in a master-password-protected KeePass file or a Windows store is not
  imported; the connection asks on connect.
- An imported connection without a password keeps the Forever mode with no value, so it asks on
  connect until the user saves one in the Data Sources dialog.
- SSH tunnels and SSL certificate files are not imported; such rows say so. Amended by decision 072:
  certificate file paths now fill the plugin's SSL fields, and Verify CA maps to `verify-ca`.
