# 083: A multi-statement run asks before it continues past an error

Status: Accepted.

## Decision

A run of more than one statement, in a console or by Run SQL Script, follows the setting
`console.runAllOnError`: `ask` (the default), `stop` or `continue`.

- `ask` pauses the run on a failed statement. The console shows a banner above its result tabs,
  "Statement 3 of 12 failed: …", with **Skip**, **Skip All**, **Stop** and **Retry**; a script's
  Services line shows the same four. Skip All continues past every later failure without asking.
  Cancel, or closing the console, answers Stop.
- `continue` logs each failure in Output and goes on; the run ends with the warning
  `12 run, 2 failed.` and every failed statement underlined (decision 082). `stop` is the old
  behaviour: the first error stops the run and Output says how many statements were skipped.
- Only `statementFailed` and `statementTimedOut` can be continued. A lost connection, a cancel or a
  busy session stops the run whatever the setting. The last statement's failure asks nothing.
- A failure inside an open transaction is continued too, with one warning that some databases,
  PostgreSQL among them, refuse every later statement until it is rolled back.
- A script answers through `script.answer { taskId, answer }`; its `ScriptTask` carries `failed`,
  the first 100 `failures` and the open `question`, and ends `done, 2 failed`. **Go to statement**
  opens the file and underlines every failure in it.

## Rationale

A seed or migration file often has a statement that fails harmlessly (a `DROP` of something
missing, a duplicate insert), and stopping there forces the user to edit and rerun. Continuing
silently is the opposite risk: a failed `CREATE` makes everything after it fail too. Asking by
default, as DataGrip does, lets the user decide with the error in front of them, and the setting
spares the question to those who always answer the same.

The errors that cannot be continued are those after which no later statement can run on the same
session, so asking would only offer a choice that fails.

## Consequences

- A run that asks holds its session; nothing else runs on that console until it is answered.
- A script keeps at most 100 failures for Go to statement, so a file failing on every line stays
  bounded; `failed` still counts them all.
