import type { FormatOptions, ParameterStyle, SqlLanguage } from "@table-craft/plugin-api";
import {
  formatDialect,
  mysql,
  plsql,
  postgresql,
  sqlite,
  transactsql,
  type DialectOptions,
  type ParamTypes,
} from "sql-formatter";
import { formatAligned } from "./layout.js";
import { Lexer, separatorLineAt, wordOf, type SqlDialectOptions } from "./tokens.js";

/** The `sql-formatter` dialects plugins may name (decisions 042 and 100). */
export const FORMAT_DIALECTS = { postgresql, mysql, sqlite, plsql, transactsql } as const satisfies Record<
  string,
  DialectOptions
>;

export type FormatDialect = keyof typeof FORMAT_DIALECTS;

export interface FormatterOptions {
  readonly dialect: FormatDialect;
  /** The same dialect options the splitter gets; `delimiterCommand` makes a `DELIMITER` line refuse. */
  readonly lexer: SqlDialectOptions;
  /** The placeholders `SqlLanguage.parameters` reads, so the formatter keeps `:id` and `$1` whole. */
  readonly parameters: readonly ParameterStyle[];
}

const DELIMITER_COMMAND = "DELIMITER";
const DELIMITER_REFUSAL = "a DELIMITER line changes what ends a statement; reformat the statements between them.";
const SEPARATOR_REFUSAL = "a batch separator line splits the script; reformat the batches between them.";
const UNREADABLE = "the text is not SQL the formatter can read.";
const NAMED_PREFIX = ":";
const NUMBERED_PREFIX = "$";
const BLOCK_COMMENT_OPEN = "/*";
const STAND_IN_TAG = "table_craft_comment_";

function paramTypes(styles: readonly ParameterStyle[]): ParamTypes {
  return {
    named: styles.includes("named") ? [NAMED_PREFIX] : [],
    numbered: styles.includes("numbered") ? [NUMBERED_PREFIX] : [],
    positional: styles.includes("positional"),
  };
}

function startsALine(text: string, from: number): boolean {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  return text.slice(lineStart, from).trim() === "";
}

function hasDelimiterCommand(text: string, dialect: SqlDialectOptions): boolean {
  const lexer = new Lexer(text, dialect);
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (token.kind === "word" && wordOf(text, token) === DELIMITER_COMMAND && startsALine(text, token.from))
      return true;
  }
  return false;
}

function hasSeparatorLine(text: string, dialect: SqlDialectOptions): boolean {
  const separator = dialect.batchSeparator;
  if (separator === undefined) return false;
  const lexer = new Lexer(text, dialect);
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (separatorLineAt(text, token, separator) !== null) return true;
  }
  return false;
}

interface Shielded {
  readonly text: string;
  readonly restore: (formatted: string) => string;
}

/**
 * The library re-indents the continuation lines of a block comment. Each multi-line one goes in as
 * a one-line stand-in, which it leaves alone, and comes back as written.
 */
function shieldBlockComments(text: string, dialect: SqlDialectOptions): Shielded {
  const lexer = new Lexer(text, dialect);
  const comments: string[] = [];
  let shielded = "";
  let at = 0;
  let salt = 0;
  while (text.includes(standIn(salt, 0))) salt += 1;
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    const content = text.slice(token.from, token.to);
    if (token.kind !== "comment" || !content.startsWith(BLOCK_COMMENT_OPEN) || !content.includes("\n")) continue;
    shielded += text.slice(at, token.from) + standIn(salt, comments.length);
    comments.push(content);
    at = token.to;
  }
  if (comments.length === 0) return { text, restore: (formatted) => formatted };
  return {
    text: shielded + text.slice(at),
    restore: (formatted) =>
      comments.reduce((result, comment, index) => result.replace(standIn(salt, index), () => comment), formatted),
  };
}

function standIn(salt: number, index: number): string {
  return `/*${STAND_IN_TAG}${String(salt)}_${String(index)}*/`;
}

/** The library's parse errors run to a page of grammar; the first line says where. */
function reasonOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  return firstLine === "" ? UNREADABLE : firstLine;
}

/**
 * `SqlLanguage.format`: the aligned layout (decision 061) or `sql-formatter`'s (decision 042), which
 * also takes every statement the aligned one does not read (decision 062). Throws an `Error` with a
 * one-line reason rather than returning half-formatted text; comments and literals pass through as
 * written.
 */
export function sqlFormatter(options: FormatterOptions): Pick<SqlLanguage, "format"> {
  const dialect = FORMAT_DIALECTS[options.dialect];
  const params = paramTypes(options.parameters);
  const standard = (text: string, format: FormatOptions): string => {
    const shielded = shieldBlockComments(text, options.lexer);
    try {
      return shielded.restore(
        formatDialect(shielded.text, {
          dialect,
          keywordCase: format.keywordCase,
          dataTypeCase: format.keywordCase,
          tabWidth: format.indentWidth,
          linesBetweenQueries: format.linesBetweenStatements,
          paramTypes: params,
        }),
      );
    } catch (cause) {
      throw new Error(reasonOf(cause), { cause });
    }
  };
  return {
    format(text, format: FormatOptions) {
      if (options.lexer.delimiterCommand === true && hasDelimiterCommand(text, options.lexer)) {
        throw new Error(DELIMITER_REFUSAL);
      }
      if (hasSeparatorLine(text, options.lexer)) throw new Error(SEPARATOR_REFUSAL);
      if (format.style === "standard") return standard(text, format);
      return formatAligned(text, format, options.lexer, (statement) => standard(statement, format));
    },
  };
}
