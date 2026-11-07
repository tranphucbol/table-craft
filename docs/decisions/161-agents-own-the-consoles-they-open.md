# 161: Agents own the consoles they open

Status: Accepted. Plan 156. Amends 126.

## Decision

An agent that opens a console through `open_in_console` gets an opaque handle (`c1`, `c2`, … per
host run) and owns that console for as long as its MCP session lives. The MCP host keeps
`handle → { session, window, datasource }`; main and the renderer keep no ownership.

- Only the owning session may `edit_console`, `read_console` or `list_consoles` it. An unknown
  handle and another session's handle get the same refusal, so a handle reveals nothing.
  `get_active_context` stays the one tool that shares a console the agent did not open.
- A console carries a `revision` that every text change bumps, the user's and the agent's.
  `edit_console` takes exact `{ oldText, newText }` edits (each must match once, applied in order)
  or a whole `text` with the revision it was read at. The window checks and applies the edit in one
  step, as one isolated undo step, and refuses with the reason (`notFound`, `ambiguous`, `stale`,
  `selectNotFound`) without changing anything.
- When the session ends or the host stops, its handles are dropped and the windows clear the
  **AI** tab marker. The console and its text stay with the user.
- All window traffic is one request/answer pair, `mcp.uiRequest` and `mcp.uiAnswer`, carrying a
  typed union. A request targets the focused window or a window id; main stamps the sender's
  `webContents` id on every answer, and the host remembers it per handle. A window that does not
  answer within 5 seconds refuses the call; one that closed refuses it as no window.
- Raising the window (`focus: true`) is main's job, and only when `mcp.allowFocus` (default on)
  allows it.

## Rationale

Agents asked to "fix the query I gave you" had no way back to the console they had filled, and
re-opening a fresh console for every revision buries the user in tabs. Letting an agent write into
any console would be simpler but hands it the user's work: a console the user typed into is
theirs, and a stale whole-text replace would silently erase their edits. Ownership per session,
with exact-match edits and a revision check made where the text lives, keeps the agent to text it
put there and loses nothing the user typed.

Keeping the handle table in the host, not in main, preserves decision 126: main relays one message
each way and holds no state, now for one request kind instead of three. Line/column edits were
rejected because the user may move text between the agent's read and its write; exact text either
still matches or refuses cleanly.

## Consequences

- Tools that change only what the window shows (`edit_console`, `open_table`,
  `reveal_in_explorer`) are `readOnlyHint: true`: they never change the user's data and never run a
  statement. `open_table` checks its filter forms one read through `script.split`, and on an
  `askReads` datasource only types it into the bars.
- Handles do not survive a host restart or an app restart; an agent re-opens a console after one.
- A new kind of window request is a new member of the `McpUiRequest` union and its answer, with
  no new channel.
