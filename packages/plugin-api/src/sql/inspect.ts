import type {
  CompletionCatalog,
  InspectionRequest,
  Problem,
  SqlLanguage,
  StatementSpan,
} from "@table-craft/plugin-api";
import { StatementView, type InspectorOptions, type StatementInspection } from "./inspectContext.js";
import { reservedProblems, resolveProblems } from "./inspectResolve.js";
import { STYLE_INSPECTIONS } from "./inspectStyle.js";
import { syntaxProblems, unterminatedProblem } from "./inspectSyntax.js";
import { namespaceTarget } from "./namespace.js";
import { nameRules, type Lookup } from "./resolution.js";
import { sqlSplitter } from "./splitter.js";
import { Lexer, type Token } from "./tokens.js";

export type { InspectorOptions } from "./inspectContext.js";

/** DataGrip's suppression comment: `-- noinspection SqlResolve,SqlSyntax` on the line above a statement. */
const NOINSPECTION = /^(?:--|#)\s*noinspection\s+([\w\s,]+)$/i;
const ID_SEPARATOR = /[\s,]+/;
const NEWLINE = "\n";

const INSPECTIONS: readonly StatementInspection[] = [
  syntaxProblems,
  resolveProblems,
  reservedProblems,
  ...STYLE_INSPECTIONS,
];

function lex(text: string, options: InspectorOptions): Token[] {
  const lexer = new Lexer(text, options.dialect);
  const tokens: Token[] = [];
  for (let token = lexer.next(); token !== null; token = lexer.next()) tokens.push(token);
  return tokens;
}

function newlines(text: string): number {
  let count = 0;
  for (let at = text.indexOf(NEWLINE); at >= 0; at = text.indexOf(NEWLINE, at + 1)) count += 1;
  return count;
}

/** The inspections the comments directly above a statement silence; a blank line ends the run. */
function suppressedBy(text: string, comments: readonly Token[], statementFrom: number): Set<string> {
  const ids = new Set<string>();
  let reach = statementFrom;
  for (let at = comments.length - 1; at >= 0; at -= 1) {
    const comment = comments[at];
    if (comment === undefined || newlines(text.slice(comment.to, reach)) > 1) break;
    const match = NOINSPECTION.exec(text.slice(comment.from, comment.to).trim());
    for (const id of match?.[1]?.split(ID_SEPARATOR) ?? []) if (id !== "") ids.add(id);
    reach = comment.from;
  }
  return ids;
}

/**
 * The shared inspector every built-in plugin spreads into its `SqlLanguage` (plan 108): it reads
 * each statement with the completer's lexer, scope and catalog lookups and reports what DataGrip's
 * inspections of the same ids would, with their quick fixes. It never rejects: a statement or an
 * inspection that throws only reports less.
 */
export function sqlInspector(options: InspectorOptions): Required<Pick<SqlLanguage, "inspect">> {
  const rules = nameRules(options);
  const split = sqlSplitter(options.dialect);

  async function inspectStatement(text: string, tokens: readonly Token[], lookup: Lookup): Promise<Problem[]> {
    const view = new StatementView(text, tokens, options, rules, lookup);
    const problems: Problem[] = [];
    for (const inspection of INSPECTIONS) {
      try {
        problems.push(...(await inspection(view)));
      } catch {
        continue;
      }
    }
    return problems;
  }

  async function follow(span: StatementSpan, lookup: Lookup): Promise<void> {
    const target = namespaceTarget(span.sql, options.dialect);
    if (target !== null) await lookup.switchTo(target);
  }

  async function inspectAll(request: InspectionRequest, catalog: CompletionCatalog): Promise<Problem[]> {
    const { text } = request;
    const disabled = new Set(request.disabled ?? []);
    const tokens = lex(text, options);
    const lookup = new rules.Lookup(catalog);
    const problems: Problem[] = [];
    const suppressions: { span: StatementSpan; ids: Set<string> }[] = [];
    let cursor = 0;
    for (const span of split(text)) {
      const comments: Token[] = [];
      while (cursor < tokens.length && (tokens[cursor]?.from ?? 0) < span.from) {
        const token = tokens[cursor];
        if (token?.kind === "comment") comments.push(token);
        cursor += 1;
      }
      const own: Token[] = [];
      while (cursor < tokens.length && (tokens[cursor]?.from ?? 0) < span.to) {
        const token = tokens[cursor];
        if (token !== undefined && token.kind !== "comment" && token.kind !== "delimiter") own.push(token);
        cursor += 1;
      }
      const ids = suppressedBy(text, comments, span.from);
      suppressions.push({ span, ids });
      try {
        const found = await inspectStatement(text, own, lookup);
        problems.push(...found.filter((entry) => !ids.has(entry.inspection)));
      } catch {
        // A statement the reader cannot follow reports nothing; the others still do.
      }
      try {
        await follow(span, lookup);
      } catch {
        // The namespace stays where it was.
      }
    }
    const unterminated = unterminatedProblem(text, tokens.at(-1), options.dialect);
    if (unterminated !== null) {
      const owner = suppressions.find(({ span }) => span.from <= unterminated.from && unterminated.from < span.to);
      if (owner === undefined || !owner.ids.has(unterminated.inspection)) problems.push(unterminated);
    }
    return problems
      .filter((entry) => !disabled.has(entry.inspection))
      .sort((left, right) => left.from - right.from || left.to - right.to);
  }

  return {
    inspect: async (request, catalog) => {
      try {
        return await inspectAll(request, catalog);
      } catch {
        return [];
      }
    },
  };
}
