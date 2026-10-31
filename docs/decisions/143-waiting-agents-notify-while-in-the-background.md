# 143: A waiting agent posts a system notification while TableCraft is in the background

Status: Accepted. Amends 127: the amber chip stays the only signal while a window is focused.

## Decision

While an approval or an unknown client waits and no TableCraft window is focused, main posts one
system notification and sets the dock badge (or the taskbar count) to the number waiting.

- Main posts it, diffing the `McpStatus` the supervisor already publishes. The renderer is not
  involved, so a minimised or hidden window still notifies.
- One notification at a time. A request that arrives while one shows replaces it with a count;
  the same set of requests is never posted twice. It closes when every request it named is
  answered, denied or timed out, or when a window gains focus.
- It names the client, the datasource and what is asked (read data, change data, read a key,
  connect) with the time left. It never shows the statement, the key or the agent's reason.
- Clicking it raises the last focused window and runs `mcp.approvals`, or `mcp.decideClient` for
  a client, through the existing invoke-action channel. It never answers the request.
- The badge counts approvals and waiting clients whenever notifications are on, focused or not.
- `settings.mcp.notifications`, on by default, turns both off. Where `Notification.isSupported()`
  is false only the badge shows, and the MCP log says so once.

## Rationale

Decision 127 kept the approval inside the window so that nothing steals keystrokes. Users leave
TableCraft in the background while the agent works in a terminal or an editor; a request there
waits a minute unseen and is denied. A system notification reaches them without moving focus or
opening anything, and the approval still happens only in the window, with Deny focused.

The statement, key and reason stay out because notification centres keep a history and show
banners on a locked screen. The client, datasource and kind are enough to decide whether to look.

`mcp.show` toggles the popover, so a click on a notification could close it; `mcp.decideClient`
with no client opens it and leaves it open.

## Consequences

- Notifications go through the OS and follow its settings: Focus modes and per-app permissions can
  silence them, and the badge then still shows.
- On Windows the app sets its AppUserModelID so notifications carry its name.
- No buttons on the banner: approving from outside the window would bypass the review 127 asks for.
- With no window open a request is still denied at once, so nothing is posted.
