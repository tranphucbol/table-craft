# 061: An aligned layout of our own is the default format

Status: Accepted. Amended by 147.

## Decision

Reformat Code (⌥⌘L) lays DML out in an **aligned** style written in
`@table-craft/plugin-api/sql` (`sql/layout*.ts`): the clause keyword, one space and the first item on
one line; the rest of a list lined up under the first item; `AS` in a select list lined up in one
column; further `AND`/`OR` right-aligned to the end of `WHERE`, `HAVING` or `ON`; calls and value
lists kept whole (an `IN` list goes one value per line since decision 147); subqueries and CTE bodies laid out by the same rules at the column after `(`.

It parses the tokens of the existing dialect `Lexer` (`tokens.ts`), not text, so quoting, comments,
placeholders and `@var` stay exactly as each dialect reads them. `FormatOptions` gains
`style: "aligned" | "standard"` (default `aligned`) and `alignAliases: boolean` (default `true`);
`standard` is today's `sql-formatter` layout (decision 042), unchanged. Keywords follow
`keywordCase`; identifiers, function names, literals and comments stay as written. Nothing wraps:
there is no line width.

## Rationale

The layout users asked for is the one DataGrip writes. `sql-formatter` cannot produce it: every
option puts clause bodies on their own lines, breaks calls across lines, and none aligns aliases or
right-aligns `AND` under `WHERE`. Another library would bring a third tokenizer that disagrees with
the splitter and the completer about quoting and comments. The lexer already answers those per
dialect, so a small parser over its tokens is enough structure for the rules.

## Consequences

- Two layouts to maintain; `sql-formatter` remains for `standard` and as the fallback (decision 062).
- The aligned layout is idempotent and token-preserving (keyword case aside); tests check both over
  every fixture, and the plugin contract runs its format round trip in both styles.
- The contract moves to 0.20.0 because `FormatOptions` grows two fields.
- Rules that need judgement are named constants in `sql/layoutPrint.ts`: `ALIAS_ALIGN_LIMIT` (an
  expression longer than this neither pads nor is padded to), `CASE_INLINE_LIMIT` (a longer `CASE`
  goes one `WHEN` per line) and `RIGHT_MARGIN` (a parenthesised condition group that would cross it
  goes one condition per line). Only that last decision depends on width; nothing is wrapped.
