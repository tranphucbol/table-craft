# Connections

The **Data Sources** dialog lists your data sources on the left and edits one on the right: name,
folder, comment, the plugin's connection fields, read-only mode and a colour that tints its tabs.
**Test Connection** reports the server version and round trip before you save. Each password has a
save mode: _Forever_ keeps it encrypted by the operating system's keychain, _Until restart_ keeps it
in memory, and _Never_ asks on every connect. A _Forever_ or _Until restart_ password left blank is
asked for when you connect, and kept in its mode once the connection works.

Paste a connection URL such as `postgresql://alice:secret@db.example.com:5432/sales?sslmode=require`
into the URL row, or into Host, and the fields fill themselves; the password goes to its save mode,
never to `datasources.json`. A SQL Server data source also takes a JDBC URL such as
`jdbc:sqlserver://db.example.com:1433;databaseName=sales;encrypt=true`. A SQLite file takes a path
or a `sqlite:` URL. **Copy as URL** in a data
source's context menu copies its URL without the password.

A PostgreSQL, MySQL, Oracle or SQL Server data source can go through an **SSH tunnel**: tick _Use SSH tunnel_ in the
SSH/SSL section, and in the rows that appear give the bastion's host, port and user, then sign in with a password, a private
key (OpenSSH or PEM, with its passphrase if it has one) or the running SSH agent. The host and port
above stay the database's address as the bastion sees it. The SSH password and passphrase take save
modes like the database password, and **Test Connection** reports each hop. The first time a bastion
is reached, TableCraft shows its key fingerprint and asks before trusting it; trusted keys go to
`ssh_known_hosts.json` beside your data sources, and those already in `~/.ssh/known_hosts` are
trusted too. A bastion whose key changed is refused, naming both fingerprints. If the tunnel drops,
the next statement reopens it.

The **SSL** rows of the same section choose how the connection is encrypted: _Disable_, _Require_
(encrypted, certificate not checked), _Verify CA_ (signed by the CA you trust) or _Verify full_ (and
issued for the host you typed, also through a tunnel). Point _SSL root certificate_ at the server's
CA file, and _Client certificate_ and _Client key_ at yours when the server signs users in by
certificate; a passphrase-protected key asks for its passphrase on connect unless you save it.
TableCraft keeps the paths and reads the files on every connect, so a renewed certificate needs no
edit. **Test Connection** names the TLS version and cipher, and a refused certificate names the CA
file or host it failed on. The URL keeps the paths too (`sslrootcert`, `sslcert`, `sslkey`;
`ssl-ca`, `ssl-cert`, `ssl-key` for MySQL).

Sessions stay healthy on their own. Every connection uses TCP keepalive (30 s by default, under
Advanced). A console idle that long checks its session before the next Run and reconnects if the
connection dropped, saying so in Output; a statement running when the network goes away fails
within one keepalive interval instead of hanging. A **statement timeout** (Settings → Editor →
Running, or per data source under Advanced) cancels a console statement that runs too long, and
**Also have the database stop it** under it hands the limit to MySQL, MariaDB, TiDB or PostgreSQL
too, so the statement stops even when TableCraft cannot reach the server; exports
and imports are not cut by it and are never reconnected mid-way, they stop only when the database
answers nothing for the Transfer stall timeout (Settings → Data Editor → Export and import). An
open transaction is never replaced silently: if its connection drops, the error says its changes
are gone. Running again while the last result still has rows to send waits for that result to
close; one that cannot close within 5 seconds costs a reconnect, which Output reports. TiDB before
6.1 cannot stop a statement safely, so Cancel there resets the session and says so.

![Connections](../media/connections.gif)

See [Datasources and secrets](../design/specification.md#datasources-and-secrets).

## Import from DataGrip or TablePro

**File → Import Data Sources…**, or the import button beside Add in the Data Sources dialog, brings
your connections over from DataGrip or TablePro. TableCraft only reads their files; it never
changes them. The first step shows what it found on this computer and where it looked; **From a
file…** reads a DataGrip `dataSources.xml` or a TablePro `.tablepro` export instead.

The next step lists every connection with its type, address, user, folder and where its password
comes from. MySQL, MariaDB and TiDB open in the MySQL plugin, PostgreSQL in the PostgreSQL plugin,
SQLite in the SQLite plugin and Oracle in the Oracle plugin (a `jdbc:oracle:thin:@//host:1521/service`
URL or its `@host:1521:SID` form); anything else is listed as not supported. A PostgreSQL or Oracle
connection found before its plugin is installed offers **Install** in its row and maps once the
plugin arrives. A connection that needs an
SSH tunnel, or one already in TableCraft, starts unticked; ticking a duplicate imports a copy named
`<name> (2)`, never overwriting the one you have. Folders and colours come along, under a
`DataGrip` or `TablePro` folder unless you turn that off.

![Import from DataGrip](../media/import-datasources.gif)

Passwords:

- **DataGrip** keeps them in the system keychain or in its own KeePass file. A KeePass file is read
  silently. From the macOS Keychain, macOS asks once for each password: click **Allow**, not
  **Always Allow**, so DataGrip's items stay private to DataGrip. Deny once and TableCraft stops
  asking and imports the rest without passwords. On Linux it asks the Secret Service through
  `secret-tool` (package `libsecret-tools`).
- **TablePro** keeps them in its own keychain items, which TableCraft does not read. Export the
  connections from TablePro as an encrypted `.tablepro` file with its passwords, then import that
  file and type the passphrase; it is used once and never stored.

Untick **Import passwords** to bring none: such a data source asks on connect, and you save its
password in the Data Sources dialog.
