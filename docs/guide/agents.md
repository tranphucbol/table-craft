# Agents (MCP)

TableCraft can serve your data sources to AI agents such as Claude Code, OpenCode and Cursor over
the [Model Context Protocol](https://modelcontextprotocol.io). It is off until you turn it on in
**Settings → MCP Server** (or the robot button on the right edge of the window), which listens on `http://127.0.0.1:47820/mcp` on this machine only and
asks every client for a bearer token. **Copy** beside a client puts its configuration, token
included, on the clipboard; the window never shows the token.

Each data source starts **Off** for agents. **Read only** lets an agent list schemas and tables,
describe a table, read its DDL, run `SELECT`s, explain and format SQL; its statements run in a
read-only session, and anything else is refused. **Ask before writes** also lets it propose one
change at a time: the MCP chip in the status bar turns amber, and nothing runs until you open the
request, read the statement and the agent's reason, and choose **Allow once**. Unanswered for a
minute, a request is denied. **Ask before reads** sits between Off and Read only: agents still
browse schemas, tables, columns and key names, but every query that returns rows, and every key
value, waits for you the same way, and writes are refused. While a statement waits, **Plan** in
the request shows how the database would run it, without running it, and marks steps such as a
full table scan or, on TiDB, estimates made without statistics; the request keeps waiting until
you answer. A data source marked read-only stays at Read only, and one coloured
red can be raised past Read only only on its own page in the Data Sources dialog. Answers carry at
most `mcp.rowCap` rows, and a statement running past `mcp.statementTimeoutSeconds` is stopped,
by the database too where it can, even if TableCraft cannot reach it; passwords never leave
TableCraft, and every agent statement is kept in the query history, tagged with the client's name. The app must be running for agents to reach it.

- **Clients.** The first call from a client you have not met turns the chip amber; open it and
  choose **Allow** or **Block**. Unanswered for a minute, the call is refused. Settings → MCP Server
  lists the clients you answered, to flip or forget.
- **Per data source.** Beside the access level, **Schemas** narrows what agents list and read
  (blank keeps the schemas the Database pane shows), **Row cap** overrides `mcp.rowCap`, and
  **Timeout** overrides `mcp.statementTimeoutSeconds`. The (i) before it says what really stops a
  statement there, from the server the data source last connected to: amber when some statements
  keep running past the limit, ringed when TableCraft has not seen the server yet.
- **Tools.** Besides the catalog and query tools, agents can check SQL against the inspections,
  hand a statement to a new console for you to run (**open in console**, which never runs it), read
  the focused console when its data source is exposed, and scan and read Redis keys. They can also
  read `tablecraft://<data source>/<schema>/<table>` resources and two prompts.
- **Watching.** The chip's popover lists connected clients and their last call, with Pause, Agent
  Activity (every call this run, filtered by client and outcome) and Settings. Services shows an
  **Agents** node with each statement still running and a Cancel. A call's time leaves out the
  wait for your approval; hover it, or read Agent Activity, to see how long it waited. A write request can also go to
  **Open in Console** instead of running. Query History filters by **All**, **Me** or **Agents**,
  and the Database pane marks exposed data sources with **AI** while the server runs.
