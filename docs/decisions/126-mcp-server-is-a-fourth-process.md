# 126: The MCP server is a fourth process

Status: Accepted

## Decision

TableCraft serves the Model Context Protocol to AI agents (Claude Code, OpenCode, Cursor) from a
fourth process, the MCP host: a `utilityProcess` whose source is `packages/desktop/src/mcp/`, built
by `vite.mcp.config.ts` to `dist/mcp/main.js`. Main forks it only while `settings.mcp.enabled` is
on, and hands it engine `MessagePort`s through the same host registry that hands them to windows,
so an agent's statements reach the engine without passing through main (decision 002).

The transport is Streamable HTTP on `127.0.0.1` only, at `http://127.0.0.1:<port>/mcp` (default
port 47820, `settings.mcp.port`). It is hand-rolled on `node:http`: JSON-RPC 2.0, protocol
versions `2025-06-18` and `2025-03-26`, JSON responses and no SSE stream, so `GET` answers 405,
`DELETE` ends a session, and `Mcp-Session-Id` is issued at `initialize`. Batches are refused.

Every request carries `Authorization: Bearer <token>`. The token is 32 random bytes in base64url
with the prefix `tc_`, kept in the secret store under the reserved owner `table-craft.mcp`
(`forever` mode, `untilRestart` when encryption is unavailable). It never reaches a renderer
(decision 020): **Copy with Token** asks main, which writes the client config to the clipboard.
`Host` must name a loopback address with the port and a present `Origin` must be loopback, which
stops DNS rebinding; bodies over 1 MiB answer 413.

Status and approvals travel host → main → windows on one broadcast channel, and the user's
answers go back window → main → host. Main keeps the last status for windows opened later.

## Rationale

The engine already speaks a message protocol over ports, one per window. A process that speaks
MCP on one side and that protocol on the other reuses every engine route, the session model and
result handles (decision 009) without a second implementation, and without putting a request
path in main, which holds no state and must stay responsive.

Running the server inside main would have been the least code, but it would put every agent call
and its results through the process that draws menus and windows. Running it in an engine would
tie it to one datasource. A separate process can also be off entirely, which is the default.

Streamable HTTP is the transport the target clients configure with a URL and a header, and
loopback HTTP needs no helper binary. A stdio launcher that bridges to the running app is left
for later. The official SDK pulls a web framework and SSE machinery for a server that needs five
methods; a few hundred lines of `node:http` are smaller and easier to fence.

## Consequences

- The app must be running for an agent to reach it; nothing serves MCP while TableCraft is closed.
- Changing the port or regenerating the token restarts the host and drops connected clients.
- The host is one more bundle in the build chain and the packaged app, and one more process name
  in the app log (`mcp`).
- A port another program holds leaves the server failed with a message naming the port; the
  status chip turns red until the user picks another.
- `open_in_console` and `get_active_context` reach the focused window through main, which relays
  one message each way; that is the one place main carries agent traffic, and it holds no state.
