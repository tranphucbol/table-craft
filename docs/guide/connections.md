# Connections

The **Data Sources** dialog lists your data sources on the left and edits one on the right: name,
folder ([arranged](explorer.md#arranging-data-sources) in the Database tree), comment, the plugin's connection fields, read-only mode and a colour that tints its tabs.
**Test Connection** reports the server version and round trip before you save. Each password has a
save mode: _Forever_ keeps it encrypted by the operating system's keychain, _Until restart_ keeps it
in memory, and _Never_ asks on every connect. A _Forever_ or _Until restart_ password left blank is
asked for when you connect, and kept in its mode once the connection works. For a server without a
password, pick **No auth** (Redis) or **None** (etcd) in Authentication: TableCraft then never
asks for one, and forgets a password it had kept.

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

## Import from DataGrip, TablePro, MySQL Workbench or Beekeeper Studio

**File → Import Data Sources…**, or the import button beside Add in the Data Sources dialog, brings
your connections over from DataGrip, TablePro, MySQL Workbench or Beekeeper Studio. TableCraft only
reads their files; it never changes them. The first step shows what it found on this computer and
where it looked; **From a file…** reads a DataGrip `dataSources.xml`, a TablePro `.tablepro`
export, a MySQL Workbench `connections.xml` or **Backup Connections** `.zip`, or a Beekeeper Studio
`app.db` instead, or a file TableCraft exported ([Export and share data sources](#export-and-share-data-sources)). When TableCraft finds
connections at launch, the [notification bell](settings.md#notifications) offers them; its
**Import…** opens straight on that app's list.

The next step lists every connection with its type, address, user, folder and where its password
comes from. MySQL, MariaDB and TiDB open in the MySQL plugin, PostgreSQL in the PostgreSQL plugin,
SQLite in the SQLite plugin and Oracle in the Oracle plugin (a `jdbc:oracle:thin:@//host:1521/service`
URL or its `@host:1521:SID` form), and Beekeeper's SQL Server and Redis connections in those
plugins; anything else is listed as not supported. A PostgreSQL or Oracle
connection found before its plugin is installed offers **Install** in its row and maps once the
plugin arrives. An SSH tunnel comes along when its host, user and sign-in method can be read (a
DataGrip SSH configuration, a Workbench **Standard TCP/IP over SSH** connection, a Beekeeper SSH
tunnel). Workbench's SSH password comes from the keychain like the database one, and Beekeeper's
SSH password and key passphrase from its `app.db`; any other SSH password or key passphrase
is asked for on connect. A tunnel TableCraft
cannot read fully, or one already in TableCraft, starts unticked; ticking a duplicate imports a
copy named `<name> (2)`, never overwriting the one you have. Folders and colours come along, under
a `DataGrip`, `TablePro`, `MySQL Workbench` or `Beekeeper Studio` folder unless you turn that off.

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
- **MySQL Workbench** keeps them in the system keychain on macOS and in the Secret Service on
  Linux, read the same way as DataGrip's. On Windows they sit in Workbench's own encrypted vault,
  which TableCraft does not read: such a data source asks on connect.
- **Beekeeper Studio** keeps them in its `app.db`, encrypted with the key in the `.key` file beside
  it; TableCraft decrypts them on import, without asking. A connection whose **Save Passwords** is
  off imports without one.

A Workbench connection's group (the text before the first `/` of its name) becomes its folder.
**Local Socket/Pipe** connections are listed as not supported, since TableCraft's MySQL connects
over TCP/IP; LDAP and Kerberos ones import their address with a warning, and options TableCraft
has no field for, such as an SSL cipher or `SQL_MODE`, are named in the row's warning. An SSL mode
of _Preferred_, the default in Workbench and TablePro, imports as _Disable_; choose _Require_ on the
data source to encrypt it.

Beekeeper Studio is found in its data folder (`~/Library/Application Support/beekeeper-studio` on
macOS, `%APPDATA%\beekeeper-studio` on Windows, `~/.config/beekeeper-studio` on Linux, and its Snap
and Flatpak folders); a portable copy's `beekeeper_studio_data\app.db` can be picked as a file.
Only the local workspace's connections are read, not a Beekeeper cloud workspace's, and nested
folders keep their path. A connection through a **jump host** imports without its tunnel and
starts unticked, since TableCraft tunnels through one SSH host; one over a **local socket** or an
Oracle **connect string** is listed as not supported, and Windows, Azure AD or IAM sign-in imports
the address with a warning. Close Beekeeper Studio first if it says it is saving.

Untick **Import passwords** to bring none: such a data source asks on connect, and you save its
password in the Data Sources dialog.

## Export and share data sources

Select data sources or folders in the Database tool window and choose **Export Data Sources…** in
their context menu, or **File → Export Data Sources…**, to write them to a JSON file
(`tablecraft-datasources.json`) you can hand to a teammate or keep for another computer. The dialog
exports the selection or every saved data source; a folder brings everything inside it, empty
folders included. Folders, colours, comments, read-only, timeouts and SSH tunnels come along; the
data source TableCraft was launched with from `TABLE_CRAFT_DATASOURCE` never does.

The file holds no passwords unless you tick **Include passwords** and type a passphrase of at least
8 characters twice. The passwords are then encrypted with that passphrase (scrypt and AES-256-GCM);
TableCraft never stores it, so tell the person who imports the file through another channel.
Without passwords, each data source asks for its password on the first connect.

Import the file with **File → Import Data Sources…** → **From a file…**. An encrypted file asks for
its passphrase; **Import without passwords** reads it without one. Rows already in TableCraft, by
the same settings or from an earlier import of the same file, start unticked. A data source whose
plugin is not installed is listed as not supported and names the plugin to download. Agent access
is never imported: such a row says it is off, and you turn it on in the data source's properties.

**Copy Data Sources** (`Mod+C` in the Database tool window) puts the selection on the clipboard in
the same format, never with passwords; **Paste Data Sources** (`Mod+V`) there, in this or another
TableCraft, opens the import list on what you copied.
