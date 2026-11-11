# 163: fetch_rows waits for approval when it runs the statement again

Status: Proposed. Amends 162.

## Decision

An agent's `fetch_rows` asks the user before it runs a statement again, and only then.

- **Held rows stay automatic.** A page inside the rows TableCraft holds, or one read on from an
  open cursor, answers at once, as before.
- **A re-run asks.** A result whose row limit is in its SQL (`refetch`, decision 162) runs again to
  reach rows past the held ones. That call waits for approval at every access level, even Read,
  with the approval subject `rerun`, kind `read`, the statement, the agent's `reason` and how many
  rows the statement reads again (`rerunRows`). The dialog says the query runs again and up to which
  row.
- **Its own grant.** "Allow re-runs" lasts the rest of the agent session on that datasource. A read
  grant never covers a re-run, and a re-run grant never covers a read.
- **One run per call.** The re-run asks for every missing row in one `result.fetchMore`, up to the
  Page size range's maximum, instead of growing by a page per run.
- **Seen like a run.** A re-run shows in Services under its datasource as `fetch_rows` and is
  recorded in the query history like `run_query`, including a denied or failed one.

## Rationale

Decision 162 made a plain `SELECT` stop after one page, so fetching further means running it again
with a larger limit. An agent paging to a high offset would make the database read every row up to
it again, unseen and unasked, while the user had approved, or allowed by access level, only the
first read. Asking on every `fetch_rows` was the other option, but pages of held rows and of an open
cursor cost the database nothing more, and an agent pages often; asking there would train the user
to click Allow without reading.

## Consequences

- An agent at Read access can be stopped by a dialog it did not meet before; the tool description
  and the server instructions say so, and `fetch_rows` takes a `reason`.
- An agent that needs deep rows should write its own `LIMIT` and `OFFSET`, or a narrower query,
  which keeps the row limit out of the SQL and the result on an open cursor.
- A re-run past the Fetch All limit stops there, as in a console.
