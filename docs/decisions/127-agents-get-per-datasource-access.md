# 127: Agents get per-datasource access, and writes wait for the user

Status: Accepted. Amended by 130: a fourth level, `askReads` (Ask before reads), makes reads wait
for the user too and refuses writes.

## Decision

Each datasource has an optional `agentAccess` in `datasources.json`: `off`, `read` (Read only) or
`ask` (Ask before writes). Absent means `off`, so nothing is exposed until the user chooses.
There is no level that writes without asking.

Effective access is capped. A datasource marked read-only caps at `read`. A datasource coloured
red, the production colour, can be set to `ask` only on its own page in the Data Sources dialog;
the MCP Server settings list disables Ask before writes for it and says why. Ephemeral datasources
(`TABLE_CRAFT_DATASOURCE`) are never exposed.

`run_query` takes exactly one statement, split and classified by the plugin (decision 008).
A `read` runs on the agent's read-only session. A `write`, `ddl` or `other` statement is refused
under `read` access, and under `ask` waits for the user, then runs on the agent's writable
session. Transaction statements are refused, so every approved statement commits on its own.
Read-only is enforced twice: by the classifier, and by a session opened with `readOnly: true`
(`session.open` gained the optional parameter; the session keeps it across reconnects).

Agents have their own sessions per datasource, opened lazily, never a console's.

A waiting write turns the status bar chip amber. Nothing opens by itself and focus never moves;
the user clicks the chip to open the approval. It shows the client, datasource, statement kind,
the agent's reason and the SQL, with Deny focused, Allow Once, and a checkbox to allow that kind
on that datasource for the rest of the agent's session, never offered for DDL or a destructive
statement. An approval unanswered for 60 seconds is denied; with no window open, or while agents
are paused, it is denied at once.

Every agent statement is recorded in the query history with the source `agent`; a refused or
denied one is recorded as cancelled with the reason.

## Rationale

An agent that can run SQL is useful for exploring and dangerous for changing data. Access per
datasource matches how users already think about connections: a scratch database and a production
one are different decisions. Defaulting to off means upgrading the app exposes nothing.

The classifier alone is a guard, not a boundary (decision 011): a function call or a dialect quirk
can hide a write. A read-only session makes the server refuse what the classifier missed, wherever
the plugin supports it.

A dialog that pops up while the user types in a console would steal keystrokes and invite a
reflexive Enter. The amber chip makes a waiting write visible without interrupting, Deny is the
default, and Enter does not approve. A timeout keeps an agent from waiting forever on a user who
walked away.

Red is the colour users give production. Requiring the datasource's own page to raise it above
Read only makes that a deliberate edit, not a slip in a long list.

## Consequences

- An agent's write is slower than the user's own: it waits for a click.
- Multi-statement transactions are not possible through MCP in v1.
- Plugins that cannot open a read-only session rely on the classifier alone for reads.
- The history marks agent runs, so the user can review what agents did.
- A client name TableCraft has not met waits for Allow or Block once (`settings.mcp.clients`), so
  a new agent on the machine is noticed; the name is self-reported, so this is a prompt, not
  authentication.
- `agentSchemas` narrows what the catalog tools and resources show, never what SQL may name:
  enforcing it on statements would mean parsing SQL in the host (decision 008).
- A write request can be handed to a console instead of run; the agent hears that the user took
  it over.
