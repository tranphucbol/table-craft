# 062: The aligned layout never half-formats

Status: Accepted

## Decision

The aligned layout (decision 061) formats a statement only when it understands all of it:
`SELECT` and set operators, `WITH`, `INSERT`/`REPLACE`, `UPDATE`, `DELETE`, each optionally behind
`EXPLAIN`/`DESCRIBE`. Anything else (DDL, procedures, unknown syntax) is
handed, statement by statement, to the standard `sql-formatter` layout. After printing, the
statement's token stream is compared with the input's (keyword case aside); a difference also falls
back to the standard layout for that statement.

## Rationale

⌥⌘L must never be worse than before the aligned style existed. A guess at the shape of DDL or a
procedural body would rearrange text the user laid out on purpose, and a printer bug that drops or
reorders a token would change what runs. Per-statement fallback keeps a script mixing `CREATE
TABLE` and `UPDATE` useful: each statement gets the best layout available for it.

## Consequences

- A script can mix both layouts; that is visible and intended.
- Unbalanced or unreadable text still fails exactly as the standard layout fails (a `Parse error`
  the console shows), because the fallback is the standard layout.
- Widening the aligned coverage means teaching the parser a statement and adding its cases; until
  then the statement keeps the standard layout.
