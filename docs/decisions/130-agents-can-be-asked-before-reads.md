# 130: Agents can be asked before reads

Status: Accepted. Amends 127.

## Decision

`agentAccess` gains a fourth level, `askReads` (**Ask before reads**). The levels are ordered from
least to most an agent can do: `off`, `askReads`, `read`, `ask`. Absent still means `off`.

Under `askReads` an agent sees the datasource and its catalog, but every call that returns row
data waits for the user's approval, in the same amber chip and dialog that writes use:

- `run_query` with a `read` statement waits. `write`, `ddl` and `other` statements are refused
  without asking, and the refusal tells the agent to ask the user to raise the level. Transactions
  are refused as at every level.
- `get_key` waits; its approval names the key and its database number instead of SQL.
- `fetch_rows` on a handle from an approved statement does not ask again.
- `list_datasources`, `list_schemas`, `list_tables`, `describe_table`, `get_ddl`, `scan_keys`,
  the schema resources, `explain` (never `ANALYZE` for agents), `format_sql`, `check_sql`,
  `open_in_console` and `get_active_context` never wait.

An approved read runs on the agent's read-only session. A read approval may always be widened to
**Allow reads on _datasource_ for the rest of this agent session**, which covers later `run_query`
reads and `get_key` calls on that datasource. The dialog says _client_ **wants to read data**, and
its kind badge uses the accent tone rather than warning.

`askReads` is not capped: a read-only datasource keeps it, and a red datasource may be set to it
from the MCP Server settings, since it is stricter than Read only.

A waiting statement, read or write, can be planned from the dialog before the user answers: a
**SQL | Plan** toggle, shown when the plugin declares `explain`. The plan is plain `EXPLAIN`, never
`ANALYZE`, on a session of its own that closes after: read-only for a read, the datasource's own
mode for a write, because MySQL refuses even `EXPLAIN UPDATE` in a read-only transaction. The
dialog gives up after 10 s on its own clock, since where the plugin cannot stop a statement (TiDB
before 6.1, decision 088) the engine sets no limit. Planning is not answering: nothing is
recorded, and the request keeps waiting.

`PlanNode` gains an optional `warnings` (plugin-api 1.7.0): sentences a reviewer should notice
about a step. The MySQL plugin warns on a full table scan (MySQL tree and JSON plans, TiDB 3 to 5)
and on TiDB estimates made without statistics (`stats:pseudo`). The dialog marks warned steps amber
and lists each distinct warning once; the MCP `explain` tool lists them for the agent.

## Rationale

Some datasources hold rows the user wants an agent to see only when the user says so: customer
data, payments, a production replica. Off hides the datasource entirely, and Read only lets an
agent read any table unasked. Neither fits.

Only row data is gated. An agent plans a query by listing tables and describing columns; prompting
on each lookup would teach the user to click Allow without reading, which defeats the prompt.
`explain` reveals table names and row estimates but no values, and agents never run it with
`ANALYZE`.

An approved read keeps the read-only session so the server still refuses what the classifier
misses (decision 127). Reads have no destructive case, so the session-wide grant is always offered.

A prompt is only as good as what the user can judge from it. An `UPDATE` without a `WHERE` reads
the same as one with an indexed `WHERE` until the plan shows a full scan. Detection lives in the
plugin, which knows its server's plan shapes (decision 008); the host only shows the sentences.
Analysing would run the statement, so the plan never does, and a plan of its own session cannot
hold the agent's session or its locks.

## Consequences

- Column names, DDL and Redis key names are visible to agents under Ask before reads. Off is the
  level that hides them.
- A build before this one reads `"askReads"` in `datasources.json` as corrupt and sets the file
  aside, so downgrading after choosing the level loses the datasource list until the user restores
  it.
- Each agent read on such a datasource costs the user a click, unless they allow reads for the
  session.
- `get_key` still has no query history row; Agent Activity records it, denied or not.
- Planning a write opens a writable session for the plan. It runs only a single plain `EXPLAIN`
  that `explainable` has checked.
- A plugin that sets no `warnings` still shows its plan, with nothing marked. The console's plan
  view does not mark warnings yet.
