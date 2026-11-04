# 001: Electron, with Bun as the toolchain

Status: Accepted. Amended by 156: a native N-API driver ships one package per platform.

## Decision

table-craft is an Electron app written in TypeScript. Bun installs dependencies, runs scripts and
pins its own version in `.bun-version`; it is not a runtime. Main, the engine and the renderer all
run on Electron's Node and Chromium.

## Rationale

The product is its database drivers, and the mature drivers are Node libraries: `pg`, `mysql2`,
`node:sqlite`, and later `tedious`, `ioredis`, `mongodb`. Tauri would put a Rust boundary between
the UI and every driver, or a Node sidecar that is Electron with extra steps. Bun as a runtime is
not on offer inside Electron, but as a package manager and script runner it is faster than npm and
already the convention in preman and autoswe.

## Consequences

- No `Bun.*` API in shipped code; a module that needs one is a module that does not run.
- Prefer pure-JS or Node-built-in drivers. A native addon means `electron-rebuild` per platform and
  per Electron upgrade, and needs its own decision.
- Vitest, not `bun test`, so tests run under the same Node semantics the app does.
