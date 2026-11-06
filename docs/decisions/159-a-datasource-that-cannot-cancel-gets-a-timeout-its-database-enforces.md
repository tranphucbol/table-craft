# 159: A datasource that cannot cancel gets a timeout its database enforces

Status: Proposed. Amends 054 and 129. Relates to 131 and 148.

## Decision

A statement timeout is offered for a datasource whose plugin declares `serverTimeout`, with or
without `cancel`. One rule, `timeoutKindOf(capabilities)` in `renderer/model/runSettings.ts`, says
who stops a statement at the limit:

| The plugin declares              | Kind     | Who stops the statement                                                |
| -------------------------------- | -------- | ---------------------------------------------------------------------- |
| `cancel`                         | `app`    | the engine cancels it; the database too when the datasource asks (129) |
| `serverTimeout` without `cancel` | `server` | only the database: every request carries `serverEnforced: true`        |
| neither                          | `none`   | nothing; no timeout is offered, as decision 054 says                   |

- **Console.** The Run Settings popover (decision 148) shows Default, Custom and None for `app`
  and `server`. For `server` a note under them says that TableCraft cannot cancel and what the
  database stops, built from the `ServerTimeout` the server last reported (`lastServer.timeout`,
  decision 131): its `setting`, and `covers: "reads"` as "Other statements run to the end".
- **Requests.** `serverEnforcedOf(datasource, kind)` is true for `server`, else it keeps the
  datasource's `enforceTimeoutOnServer`. Console runs, Explain and the table editor send it, so
  the engine adds `serverTimeoutMs` as decision 129 describes. The engine is unchanged: with no
  `cancel` it arms no timer (decision 054), and it never sent `serverTimeoutMs` on `cancel`.
- **Data Sources.** The Statement timeout field shows for `app` and `server`. For `server`
  **Also have the database stop it** is ticked and disabled, since it is the only stop, and is not
  stored: the kind implies it.
- **Plugin API.** `serverTimeout` no longer requires `cancel`. No capability, field or method is
  added, so `API_VERSION` stays. The conformance suite runs the cancel-during-limit case only for
  a plugin with `cancel`, and the lower-own-limit case only when the fixture has `sessionTimeout`.
- **Never by plugin id** (decision 007): the kind and the note come from capabilities and from what
  the server reported.

## Rationale

Some plugins can never cancel: a plugin that reaches MySQL through an HTTP proxy that runs one
statement per request has no connection to send `KILL QUERY` on, but it can still add
`MAX_EXECUTION_TIME` to the statement. Under decision 054 such a datasource had no timeout at
all, so the only limit was whatever the plugin fixed at connect. Decision 129 had made
`serverTimeout` require `cancel` because the database was a second line behind the engine's
timer; nothing in the engine depended on that, and the agents' path (decision 131) already
explains "TableCraft cannot cancel, the database stops it".

Sending `serverEnforced` always for the `server` kind, instead of leaving it to the checkbox, keeps
one meaning for the field: the user asked for a timeout, and the database is the only thing that
can honour it.

## Consequences

- A `server` datasource with no limit from its server (`limit: null`, an older server version)
  still shows the timeout, and the note says nothing stops a statement there; the engine sends no
  `serverTimeoutMs`.
- With the default timeout of 0, nothing changes for such a datasource until the user sets one.
- Writes are not stopped where the server covers only reads; the note says so.
- Key tabs read through `keyValue`, which has no `serverTimeoutMs`, so a key read on a plugin
  without `cancel` still has no timeout.
- An older host never offers the timeout without `cancel`, so a plugin that declares
  `serverTimeout` without it stays safe there: it just gets no `serverTimeoutMs`.
