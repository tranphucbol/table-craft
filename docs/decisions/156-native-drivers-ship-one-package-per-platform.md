# 156: A native driver ships one package per platform

Status: Accepted. Plan 152. Amends 001, 109 and 110.

## Decision

An optional plugin may carry a native driver when no pure-JS one exists. DuckDB is the first:
`@duckdb/node-api`, pinned to an exact version.

- **Build.** Vite inlines the driver as usual, but replaces its binding loader with a shim that
  loads `./duckdb.node` beside `index.js` (`nativeBinding` in `vite.plugins.config.ts`). The plugin
  imports the driver only inside `connect`, so loading the plugin never opens the binary: the
  packing check loads every platform's package on one machine, and a package missing its binary
  still loads and says to reinstall when it connects.
- **Package.** One npm package per platform, `@tablecraft-app/plugin-<id>-<platform>-<arch>`, for
  `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64` and `win32-arm64`. Each
  holds the same `index.js` and manifest, that platform's `duckdb.node` and DuckDB library, the
  binding's licence as `THIRD-PARTY-NOTICES`, `os` and `cpu`, and `tableCraft.platform`. Still no
  dependencies and no install scripts. `plugins:pack` downloads the binding packages the lockfile
  pins and refuses one whose sha512 differs; `plugins:check` runs `SELECT 42` through the host's.
- **Install.** The catalog lists the platforms a native plugin is published for. The app downloads
  the package for `process.platform`-`process.arch` and, on another platform, refuses with
  `unsupportedPlatform` before downloading anything; Settings shows no entry there. **Install from
  File…** refuses a package built for another platform, naming the right one. Updates and the
  reinstall of an outdated major go through the same package name.
- **macOS.** The app's entitlements add `com.apple.security.cs.disable-library-validation`, since
  the DuckDB library is signed by its own team and the hardened runtime would refuse to load it.
- **Windows** needs the Visual C++ Redistributable; connecting without it says so.

## Rationale

The plugin bundle is one `index.js` with no `node_modules` (decision 109), and Rolldown cannot inline
a `.node` file. The DuckDB binding is N-API, so one build runs in every Node and Electron with no
`electron-rebuild` (decision 001's worry). One package with every platform's library would be
about 90 MB compressed, above the installer's 64 MiB cap (decision 110), and would make every user
download five systems they do not run. npm's own `optionalDependencies` would need an installer
that resolves dependencies, which decision 110 chose not to have.

Rejected: shipping DuckDB inside the app (every installer grows by 20 to 30 MB for a database most
users never open), the WebAssembly build (no file locks, no native Parquet speed, no extension
downloads), and building DuckDB from source (hours per platform in CI).

## Consequences

- Library validation is off for the whole app on macOS: any library the app loads is no longer
  required to carry its own team's signature. Gatekeeper and the hardened runtime otherwise stay.
- Packing needs the network and makes six tarballs of 20 to 29 MB each per release.
- A platform DuckDB publishes no binding for, such as Linux on musl or 32-bit Windows, gets no
  DuckDB plugin.
- A second native plugin adds its id to `BINDING_PACKAGES` (`scripts/plugins/native.ts`), its
  platforms to its catalog entry and its smoke query to `plugins:check`.
