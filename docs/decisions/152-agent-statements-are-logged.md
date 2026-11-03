# 152: Agent statements are logged

Status: Proposed. Amends 038.

## Decision

The MCP host writes what agents do into the one app log (decision 038), from the `mcp` process
under scope `agent` (plan 146):

- `agent connected` and `agent disconnected` (with `by`: `client` for its HTTP DELETE, `user` for
  Disconnect), each with the client's session id and name.
- `agent call` for every tool call, catalog reads and refusals included: tool, datasource,
  outcome, call time, approval wait, row count, the failure message and `target`, the whole
  statement, key or result handle the tool acted on. `error` is `warn`; every other outcome is
  `info`.
- `approval asked` when a dialog opens, and `approval answered` for every request's end, sharing
  `approvalId`. A request refused without asking (agents paused, no window) has no id.

Decision 038's "never logged: SQL text" now reads: never the SQL a user runs. The SQL an agent sent
is logged in full, redacted like every record: keys that name a secret, URL user information and
the values of every secret main handed to an engine. Row values and result bodies are never
logged.

A record over 16 KB first has each string field cut to 2,048 characters, keeping its other fields;
only a record still too long falls back to its envelope and message.

## Rationale

Agent Activity keeps 200 calls in memory and the query history keeps statements, but neither
says who connected, which approval was asked and how it ended, or what a catalog read did, and
neither travels in Export Diagnostics. The question "what did the agent do, and why did it stop"
needs the statements: a call record without its SQL says only that something ran. The user's own
statements stay out, because they are not what the log is for and the user can see them in the
query history.

Detecting secrets inside SQL (`IDENTIFIED BY '...'`) would need SQL knowledge in main, which
belongs to the plugin (decision 008); the query history already keeps the same text.

## Consequences

- Export Diagnostics carries the statements agents sent; its confirmation and the user guide say
  so.
- A literal password typed into a statement an agent sent stays as written in the log.
- A chatty agent writes one record per call; rotation (5 MB × 5) bounds the files as before.
- A client that goes away without DELETE writes no `agent disconnected`; MCP has no signal for it.
