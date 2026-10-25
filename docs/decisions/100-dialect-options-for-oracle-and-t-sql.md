# 100: Dialect options for Oracle and T-SQL

Status: Accepted. Plugin API 1.0.0 (added before its first release tag, decision 106).

## Decision

The shared SQL kit (`@table-craft/plugin-api/sql`) learns what Oracle and SQL Server scripts
need, as options that default off, so a plugin builds its `language` from the kit rather than
lexing on its own.

- **Lexer** (`SqlDialectOptions`, `sql/tokens.ts`): `bracketIdentifiers` reads `[a]]b]` as one
  quoted identifier; `qQuotes` reads Oracle `q'<delim>…<delim>'` strings, pairing `[ { ( <`;
  `nationalStrings` reads `N'…'` (and `n'…'`) as one string; `batchSeparator: "go" | "slash"`
  names the separator line.
- **Separator lines.** `GO`, optionally `GO <n>`, case-blind, optionally followed by a `--`
  comment, or `/` alone, recognised only as a whole line outside quotes and comments. The line
  belongs to no statement. Under either separator a routine definition (`CREATE [OR REPLACE | OR
ALTER] [EDITIONABLE | NONEDITIONABLE] PROCEDURE | FUNCTION | TRIGGER | PACKAGE | TYPE`, or
  `ALTER` of one under `go`) runs to the separator or the end of the text, keeping its own `;`;
  under `slash` an anonymous block (`DECLARE` or `BEGIN` first) does the same. Everything else
  still ends at `;`. `GO <n>` sets `StatementSpan.repeat` to `n` on the span it ends.
- **Literals.** `quoteIdentifierWith('[')` doubles `]`; `sqlLiteral`'s `nationalText` writes
  `N'…'` for text holding a non-ASCII character.
- **Placeholders.** `NativePlaceholder` gains `colonNumbered` (`:1, :2, :3`, one per occurrence)
  and `atNumbered` (`@p1`, one per name, reused).
- **Formatter.** `FORMAT_DIALECTS` gains `plsql` and `transactsql`; the aligned layout takes a
  statement in each. A script holding a separator line is refused, as `DELIMITER` is.
- **Contract suite.** `ContractFixture.sql` (`ContractSql`: one-row select, the large result,
  the explain join, the shared scripts, drop-if-exists, the temporary table, `BEGIN`) defaults
  to today's text, and `foldName` folds fixture names the suite compares (identity by default;
  `"Line Items"` is never folded).

## Rationale

Plans 054 (Oracle) and 055 (SQL Server) would otherwise each patch the same lexer, splitter,
binder and contract suite. Doing it once, with each option off by default, keeps the three
existing plugins' splits and SQL byte-identical (pinned by tests) and leaves the two plugins only
their own knowledge (decision 008).

Separators are whole lines because both SQL\*Plus and `sqlcmd` treat them so; a `GO` inside a
string or a comment is text. A routine definition runs to the separator because its body holds
`;` that both clients send whole. node-oracledb binds an array by position of occurrence, so
`:n` counts occurrences; tedious binds by name, so `@pn` is reused for a repeated name.

## Consequences

- The aligned formatter leaves `TOP` and `ROWS` (in `FETCH FIRST 10 ROWS ONLY`) in the case they
  were typed; plans 054 and 055 own any keyword-case fix.
- The contract suite still writes a few statements Oracle or T-SQL read differently (the
  multi-row `INSERT … VALUES (1), (2)`, the `EXPLAIN` statement check, the completion join text);
  each plugin plan extends `ContractSql` for what it needs.
