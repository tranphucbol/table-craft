# 025: Result cursors stay open until the session moves on

Status: Accepted. Amended by 162: a plain `SELECT` carries its row cap in its SQL and fetches by running again.

## Decision

A statement fetches one page (`RESULT_PAGE_ROWS`, 500) and leaves its row iterator open in the
engine. The grid's Fetch Next Page and Fetch All pull more from that iterator, up to
`RESULT_FETCH_ALL_CAP` (100,000) per result. Reaching the cap ends fetching but keeps the cursor
for an export. The cursor closes, keeping the rows already fetched, when:

- the result is exhausted
- the same session runs another statement
- the result is released (tab closed or replaced) or the engine exits
- the transaction it lives in ends (commit, rollback, mode switch)

A result whose cursor closed early says so ("500+ rows · fetching stopped") and offers Rerun, not
Fetch.

Sorting a console result is local: the engine sorts the rows already fetched, through a permutation,
comparing by the column's type (numbers numerically, decimals digit by digit, text by code point,
`NULL` last ascending). Server-side `ORDER BY` sorting is the table editor's (plan 008).

## Rationale

Decision 009 already called for on-demand fetching; plan 001 drained eagerly to 10,000 rows because
nothing else existed yet. Draining a 50-million-row `SELECT *` to 10,000 rows on every run costs the
database and the wire for rows nobody scrolls to, which is the DataGrip complaint this app should
not inherit. Re-running with `LIMIT/OFFSET` per page was the alternative; it is wrong for
non-deterministic queries, repeats side effects of functions in the select list, and cannot work for
arbitrary SQL without parsing it.

Holding the cursor has a cost: the session is busy, and a Postgres cursor holds its snapshot and
`AccessShare` locks while open. Closing it the moment the session moves on bounds that cost to
"until you do something else in this console", which matches how a user reads a result.

## Consequences

- In a batch, every result except the last stops at one page. The tab says so; Rerun runs that
  statement alone.
- An open cursor in auto-commit mode is an open read transaction on Postgres. The transaction badge
  stays off, since nothing the user wrote is pending, but DDL from another session on those tables
  waits until the cursor closes.
- Sorting a partly fetched result sorts only the fetched rows, and the header says "sorted locally".
- Export drains the rest of an open cursor straight to the file without the fetch-all cap, so a
  full export never needs a full fetch into memory. A result fetched to the cap still holds its
  cursor, so its export writes the rows past the cap too.
