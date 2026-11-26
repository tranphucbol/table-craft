# Where your data lives

TableCraft keeps what it saves in one profile folder on your machine. Besides your databases, it
talks only to GitHub and the npm registry.

## Profile folder

Everything is stored in one profile folder:

- macOS: `~/Library/Application Support/table-craft`
- Windows: `%APPDATA%\table-craft`
- Linux: `~/.config/table-craft`

| Path                   | Holds                                                                      |
| :--------------------- | :------------------------------------------------------------------------- |
| `datasources.json`     | Data sources and folders, without passwords                                |
| `secrets.json`         | Passwords saved _Forever_ and the MCP token, encrypted with the keychain   |
| `ssh_known_hosts.json` | The SSH host keys you chose to trust                                       |
| `consoles/`            | One folder per data source with its console files                          |
| `history.sqlite`       | Query history                                                              |
| `settings.json`        | [Settings](settings.md#settings-file)                                      |
| `snippets.json`        | Your [Snippets](completion.md#snippets), including their plain-text bodies |
| `logs/`                | The app log, `table-craft.log` and up to four older files of 5 MB each     |
| `update-state.json`    | The version you chose to skip                                              |
| `update-swap.log`      | The last macOS update's swap, logged and removed at the next launch        |
| `themes/`              | Your themes                                                                |
| `plugins/`             | Your plugins                                                               |
| `managed-plugins/`     | Plugins TableCraft downloaded, one folder per version                      |

## Passwords and the log

Passwords are never written to `datasources.json` or to the log. There is no plaintext fallback:
where the keychain cannot encrypt, _Forever_ is disabled.

The log keeps none of the SQL you run. It does keep the statements [agents](agents.md) sent, as the
query history does.

## Network

Apart from the databases you connect to, TableCraft talks only to GitHub, to
[check for updates](install.md#updates), and to the npm registry, to
[download plugins](plugins.md#databases-in-the-box-and-on-demand). It sends nothing about you to
either.

PostgreSQL and MySQL copies stream rows between the two local TableCraft database connections.
Verification reads and hashes rows locally. Neither operation sends database content to GitHub,
npm, or another cloud or third-party service.

### Check for updates only when you ask

Turn off **Check for updates automatically** in **Settings → Advanced**. TableCraft then asks only
when you choose **Help → Check for Updates…** or install a plugin.

### Keep DuckDB offline

DuckDB itself downloads extensions from `extensions.duckdb.org` when a query needs one. Turn that off
per data source, as [DuckDB](duckdb.md) shows.

## Notifications

[Agent notifications](agents.md) go through your system's notification centre, which may keep them.
They name the client and the data source, never a statement, key or reason.
