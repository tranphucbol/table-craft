# Where your data lives

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

Passwords are never written to `datasources.json` or to the log, and there is no plaintext fallback:
where the keychain cannot encrypt, _Forever_ is disabled. Apart from the databases you connect to,
TableCraft talks only to GitHub, to [check for updates](install.md#updates), and to the npm registry, to
[download plugins](plugins.md#databases-in-the-box-and-on-demand), and sends nothing about you to either;
turn **Check for updates automatically** off and it asks only when you choose **Help → Check for
Updates…** or install a plugin.
