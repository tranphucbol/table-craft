# 147: An IN value list goes one value per line

Status: Accepted

## Decision

In the aligned layout (decision 061), the parenthesised list after `IN` or `NOT IN` that holds two
or more values goes one value per line, each under the first at the column after `(`, the comma at
the end of its line and `)` glued to the last value:

```sql
SELECT *
FROM orders
WHERE order_id IN (1001,
                   1002,
                   1003);
```

It does so whatever the width. A single value and an `IN (SELECT ...)` subquery keep their layout,
and a row-value list (`(a, b) IN ((1, 2), (3, 4))`) goes one tuple per line. Calls and every other
list stay whole; the `standard` style is unchanged.

## Rationale

DataGrip, whose layout the aligned style follows, chops an `IN` list, and users paste lists of ids
into it far more often than any other list. Kept whole, a list of a few dozen ids is one long line
that hides the conditions after it and makes one id hard to find or remove. Chopping only past
`RIGHT_MARGIN` was the alternative: a list would then change shape when one value is added or a
column renamed, and two lists in one statement could lay out differently. One rule that does not
depend on width reads the same everywhere and stays idempotent.

## Consequences

- Amends decision 061's "calls and value lists kept whole": calls still are, `IN` lists are not.
- A short list takes as many lines as it has values; that is the price of a layout that does not
  move with width.
- A parenthesised condition group holding a chopped list is multi-line, so it expands one condition
  per line (rule 10), and a `CASE` holding one goes one `WHEN` per line.
- No `FormatOptions` field: the plugin API surface is unchanged.
