# 148: A console can override its run limits

Status: Proposed. Amends 054.

## Decision

Each console carries its own run settings, opened from the gear on its toolbar (**Run Settings…**):

- **Rows**: Default, a custom page size (10–10,000), or All. A custom page size is sent as the
  request's `pageRows`, with `fetchAllCap` raised to at least that size. All sends the default
  paging and then fetches the rest of the result as Fetch All does, still stopping at the Fetch All
  limit. Nothing is written into the SQL.
- **Statement timeout**: Default, a custom number of seconds (1–86,400), or None. A custom or None
  timeout wins over both Settings → Advanced and the datasource's own timeout, which decision 054
  otherwise puts first. Whether the database enforces it too still follows the datasource
  (decision 129).

They apply to the console's Run, Run All, Explain (the timeout) and Refresh, from the next
statement on; open results keep their paging. They live with the open console and are not saved.

## Rationale

The page size, the Fetch All limit and the timeout were global, so one console that needed every
row or a short leash meant changing a setting for every console and changing it back. DataGrip
puts its Query Execution settings behind a gear on the console toolbar; a per-console override is
the part of that a TableCraft user reaches for.

The timeout chosen in a console is the most specific choice the user has made, so it beats the
datasource's, which is chosen once for every console on it. Rewriting the SQL with `LIMIT` would
put SQL knowledge in the renderer (decision 008); a page size and Fetch All do the same job through
the requests the engine already takes, so neither the protocol nor the plugin contract changes.

## Consequences

- No protocol or plugin-api change; the engine sees the same requests with other values.
- All rows is bounded by the Fetch All limit, so it cannot pull an unbounded result into the
  engine.
- Run settings vanish when the console closes or the app quits. Saving them with a file console is
  left for later.
- Table tabs, key tabs and the agent tools keep the global limits.
