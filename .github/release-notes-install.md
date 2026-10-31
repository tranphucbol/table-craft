## Install

Already on TableCraft? It updates itself; nothing to do. For a new install, download the file for your machine from **Assets** below.

| Platform              | File                                   |
| :-------------------- | :------------------------------------- |
| macOS (Apple silicon) | `TableCraft-<version>-arm64.dmg`       |
| macOS (Intel)         | `TableCraft-<version>-x64.dmg`         |
| Windows x64           | `TableCraft-<version>-x64.exe`         |
| Linux x64             | `TableCraft-<version>-x86_64.AppImage` |

**macOS**: the app is not notarized, so the first launch says _“TableCraft” is damaged_ or _“TableCraft” Not Opened_. Open the DMG, drag `TableCraft.app` to `/Applications`, then clear the download attribute once and open TableCraft as usual:

```sh
xattr -dr com.apple.quarantine /Applications/TableCraft.app
```

**Windows**: SmartScreen says _Windows protected your PC_; click **More info**, then **Run anyway**.

**Linux**: run `chmod +x TableCraft-*.AppImage`, then the AppImage.

More in the [install guide](https://github.com/tranphucbol/table-craft/blob/main/docs/guide/install.md#running-the-unsigned-macos-app), including how to [check a download](https://github.com/tranphucbol/table-craft/blob/main/docs/guide/install.md#check-a-download) against `SHA256SUMS`.
