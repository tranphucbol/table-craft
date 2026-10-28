import type { Problem, QuickFix } from "@table-craft/plugin-api";
import { problem, replacement, type StatementView } from "./inspectContext.js";
import { levels, MAX_EXPANSION_DEPTH, referenceName, visibleCtes } from "./resolution.js";
import { CLAUSE_WORDS, unquote, type Identifier, type Query, type RelationSource, type Source } from "./scope.js";
import { suggestions } from "./suggest.js";

const RESOLVE = "SqlResolve";
const AMBIGUOUS = "SqlAmbiguousColumn";
const RESERVED = "SqlReservedWordAsName";
const OPEN = "(";
const DOT = ".";
const STAR = "*";
const COMMA = ",";
const AS = "AS";
const USING = "USING";
const NATURAL = "NATURAL";
/** Clauses whose names are column references. */
const COLUMN_CLAUSES = new Set([
  "SELECT",
  "WHERE",
  "ON",
  "HAVING",
  "SET",
  "RETURNING",
  USING,
  "ORDER BY",
  "GROUP BY",
  "PARTITION BY",
]);
/** Symbols right before a word that make it a parameter or variable: `:name`, `@var`, `x::type`. */
const PARAMETER_MARKS = new Set([":", "@", "?"]);
const PARAMETER_START = /^[$@:]/;
const PARAMETER_OR_TEMPORARY = /^[@#]/;
/** Rows a statement may name without declaring them: PostgreSQL's `EXCLUDED`, a trigger's `NEW` and `OLD`. */
const PSEUDO_RELATIONS = new Set(["EXCLUDED", "NEW", "OLD"]);
const RELATION_INTRODUCERS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "STRAIGHT_JOIN"]);
/** Words that may follow a relation introducer without naming a relation. */
const NOT_RELATION_NAMES = new Set([
  "DUAL",
  "LATERAL",
  "ONLY",
  "IGNORE",
  "LOW_PRIORITY",
  "QUICK",
  "DELAYED",
  "HIGH_PRIORITY",
  "OUTFILE",
  "DUMPFILE",
]);
const NOT_TABLE_UPDATES = new Set(["KEY", "FOR"]);
/** How many other namespaces an unresolved table is looked for in, so one typo cannot describe a whole server. */
const MAX_QUALIFY_NAMESPACES = 8;
const FROM_CLAUSE = "FROM";

function suggestionFixes(view: StatementView, name: Identifier, candidates: Iterable<string>): QuickFix[] {
  return suggestions(name.name, candidates).map((candidate) =>
    replacement(`Did you mean '${candidate}'?`, name, view.quoted(candidate)),
  );
}

/** The columns a source exposes, or null when the catalog or the SQL leaves them unknown. */
async function knownColumns(view: StatementView, source: Source, query: Query, depth = 0): Promise<string[] | null> {
  if (depth > MAX_EXPANSION_DEPTH) return null;
  if (source.kind === "derived") {
    if (view.isSymbol(view.nextIndex(source.to), OPEN)) return null;
    return selectColumns(view, source.query, depth + 1);
  }
  if (view.roleOf(source) !== "relation") return null;
  if (source.qualifier.length === 0) {
    const cte = view.rules.cteNamed(query, source.name);
    if (cte !== undefined) {
      if (cte.columns !== null) return cte.columns.map((column) => column.name);
      return selectColumns(view, cte.query, depth + 1);
    }
  }
  const found = await view.lookup.relation(source.qualifier, source.name);
  return found === null ? null : found.relation.columns.map((column) => column.name);
}

async function selectColumns(view: StatementView, query: Query, depth: number): Promise<string[] | null> {
  if (query.opaqueSelect || query.select.length === 0) return null;
  const columns: string[] = [];
  for (const item of query.select) {
    if (item.kind === "named") {
      columns.push(item.name.name);
      continue;
    }
    const sources = query.sources.filter((source) => {
      if (item.qualifier === null) return true;
      const reference = referenceName(source);
      return reference !== null && view.rules.sameIdentifier(reference, item.qualifier);
    });
    for (const source of sources) {
      const found = await knownColumns(view, source, query, depth);
      if (found === null) return null;
      columns.push(...found);
    }
  }
  return columns;
}

/** The sources whose columns a level's expressions read: not an `INTO` target, nor a misread `UPDATE`. */
function readSources(view: StatementView, query: Query): Source[] {
  return query.sources.filter((source) => {
    if (source.kind === "derived") return true;
    const role = view.roleOf(source);
    return role === "relation" || role === "function";
  });
}

/** A name token, keywords included: after a dot even a reserved word is a name. */
function anyName(view: StatementView, index: number): Identifier | null {
  const token = view.token(index);
  if (token === undefined) return null;
  const raw = view.raw(index);
  if (token.kind === "quoted") return { name: unquote(raw), quoted: true, from: token.from, to: token.to };
  if (token.kind !== "word" || /^[0-9]/.test(raw)) return null;
  return { name: raw, quoted: false, from: token.from, to: token.to };
}

function isParameter(view: StatementView, index: number): boolean {
  const before = view.token(index - 1);
  return (
    PARAMETER_START.test(view.raw(index)) ||
    (before !== undefined && before.kind === "symbol" && PARAMETER_MARKS.has(view.raw(index - 1)))
  );
}

/** Whether the token before `index` ends an expression, so a name here is that expression's alias. */
function followsOperand(view: StatementView, index: number): boolean {
  const before = view.token(index - 1);
  if (before === undefined) return false;
  if (before.kind === "quoted" || before.kind === "string") return true;
  if (before.kind === "symbol") return view.raw(index - 1) === ")";
  if (before.kind !== "word") return false;
  const word = view.raw(index - 1);
  return /^[0-9]/.test(word) || !view.isKeyword(word);
}

async function unresolvedRelation(view: StatementView, query: Query, source: RelationSource): Promise<Problem[]> {
  if (view.roleOf(source) === "notRelation" || view.roleOf(source) === "function") return [];
  if (view.verb === "SELECT" && view.roleOf(source) === "target") return [];
  if (source.qualifier.length === 0 && view.rules.cteNamed(query, source.name) !== undefined) return [];
  if (!source.name.quoted && NOT_RELATION_NAMES.has(source.name.name.toUpperCase())) return [];
  // SQL Server's `#temp` and `@table` live in no catalog the explorer reads.
  if (!source.name.quoted && PARAMETER_OR_TEMPORARY.test(source.name.name)) return [];
  const { lookup } = view;
  let path = lookup.current;
  if (source.qualifier.length > 0) {
    const namespace = await lookup.namespace(source.qualifier);
    if (namespace === undefined) {
      const namespaces = (await lookup.namespaces()).filter((candidate) => !candidate.system);
      const owner = source.qualifier.at(-1);
      if (namespaces.length === 0 || owner === undefined) return [];
      const kind = namespaces[0]?.kind ?? "schema";
      const fixes = suggestionFixes(
        view,
        owner,
        namespaces.map((candidate) => candidate.path.at(-1) ?? candidate.name),
      );
      return [problem(RESOLVE, "error", owner, `Unable to resolve ${kind} '${owner.name}'`, fixes)];
    }
    path = namespace.path;
  }
  if (path === null) return [];
  const relations = await lookup.relations(path);
  if (relations.length === 0 || (await lookup.relation(source.qualifier, source.name)) !== null) return [];
  const candidates = [
    ...relations.map((relation) => relation.name),
    ...(source.qualifier.length === 0 ? visibleCtes(query).map((cte) => cte.name.name) : []),
  ];
  const fixes = suggestionFixes(view, source.name, candidates);
  if (source.qualifier.length === 0) fixes.push(...(await qualifyFixes(view, source.name)));
  return [problem(RESOLVE, "error", source.name, `Unable to resolve table '${source.name.name}'`, fixes)];
}

/** "Qualify with `s`" for each other namespace that holds the table. */
async function qualifyFixes(view: StatementView, name: Identifier): Promise<QuickFix[]> {
  const { lookup } = view;
  const current = JSON.stringify(lookup.current);
  const others = (await lookup.namespaces())
    .filter((namespace) => !namespace.system && JSON.stringify(namespace.path) !== current)
    .slice(0, MAX_QUALIFY_NAMESPACES);
  const fixes: QuickFix[] = [];
  for (const namespace of others) {
    const relations = await lookup.relations(namespace.path);
    if (!relations.some((relation) => view.rules.denotes(name, relation.name))) continue;
    const owner = view.quoted(namespace.path.at(-1) ?? namespace.name);
    fixes.push({ title: `Qualify with '${owner}'`, edits: [{ from: name.from, to: name.from, insert: `${owner}.` }] });
  }
  return fixes;
}

/** Whether the catalog knows the current namespace's tables; without it every name stays unreported. */
async function catalogAnswers(view: StatementView): Promise<boolean> {
  const current = view.lookup.current;
  return current !== null && (await view.lookup.relations(current)).length > 0;
}

interface Reading {
  readonly source: Source;
  readonly columns: string[] | null;
}

async function readingsOf(view: StatementView, query: Query): Promise<Reading[][]> {
  return Promise.all(
    levels(query).map((level) =>
      Promise.all(
        readSources(view, level).map(async (source) => ({
          source,
          columns: await knownColumns(view, source, level),
        })),
      ),
    ),
  );
}

/** Names the select lists give their expressions: `x AS name` or `x name`, not a bare column. */
function selectAliases(view: StatementView, query: Query): Identifier[] {
  return levels(query).flatMap((level) =>
    level.select.flatMap((item) => {
      if (item.kind !== "named") return [];
      const index = view.indexAt(item.name.from);
      return view.word(index - 1) === AS || followsOperand(view, index) ? [item.name] : [];
    }),
  );
}

/** Whether a level merges same-named columns, so an unqualified one is not ambiguous. */
function mergesColumns(view: StatementView, query: Query): boolean {
  return view.places.some(
    (place, index) => place.query === query && (view.word(index) === USING || view.word(index) === NATURAL),
  );
}

async function unqualifiedColumn(view: StatementView, index: number, name: Identifier): Promise<Problem[]> {
  const place = view.places[index];
  if (place === undefined) return [];
  const { query } = place;
  const { rules } = view;
  if (rules.sourceNamed(query, name) !== undefined || rules.cteNamed(query, name) !== undefined) return [];
  const aliases = selectAliases(view, query);
  const aliased = aliases.some((alias) => rules.sameIdentifier(alias, name));
  const readings = await readingsOf(view, query);
  const has = (reading: Reading): boolean => reading.columns?.some((column) => rules.denotes(name, column)) === true;
  for (const [depth, level] of readings.entries()) {
    const owners = level.filter(has);
    if (owners.length === 0) continue;
    const levelQuery = levels(query)[depth];
    if (owners.length < 2 || aliased || levelQuery === undefined || mergesColumns(view, levelQuery)) return [];
    const fixes = owners.flatMap(({ source }) => {
      const reference = referenceName(source);
      if (reference === null) return [];
      const owner = view.quoted(reference.name);
      return [{ title: `Qualify with '${owner}'`, edits: [{ from: name.from, to: name.from, insert: `${owner}.` }] }];
    });
    return [problem(AMBIGUOUS, "error", name, `Column reference '${name.name}' is ambiguous`, fixes)];
  }
  const all = readings.flat();
  if (aliased || all.length === 0 || all.some((reading) => reading.columns === null)) return [];
  const candidates = [...all.flatMap((reading) => reading.columns ?? []), ...aliases.map((alias) => alias.name)];
  const fixes = suggestionFixes(view, name, candidates);
  return [problem(RESOLVE, "error", name, `Unable to resolve column '${name.name}'`, fixes)];
}

async function qualifiedColumn(view: StatementView, index: number): Promise<Problem[]> {
  const place = view.places[index];
  const owner = view.name(index - 2) ?? anyName(view, index - 2);
  if (place === undefined || owner === null || view.isSymbol(index - 3, DOT) || isParameter(view, index - 2)) return [];
  const { rules } = view;
  const source = rules.sourceNamed(place.query, owner);
  if (source === undefined) {
    if (PSEUDO_RELATIONS.has(owner.name.toUpperCase()) && !owner.quoted) return [];
    if (!(await catalogAnswers(view))) return [];
    const references = levels(place.query)
      .flatMap((level) => readSources(view, level))
      .map((candidate) => referenceName(candidate)?.name)
      .filter((name) => name !== undefined);
    const fixes = suggestionFixes(view, owner, references);
    return [problem(RESOLVE, "error", owner, `Unable to resolve table '${owner.name}'`, fixes)];
  }
  const name = anyName(view, index);
  if (name === null) return [];
  const columns = await knownColumns(view, source, place.query);
  if (columns === null || columns.some((column) => rules.denotes(name, column))) return [];
  const fixes = suggestionFixes(view, name, columns);
  return [problem(RESOLVE, "error", name, `Unable to resolve column '${name.name}'`, fixes)];
}

/** `INSERT INTO t (a, b)`: each listed name against the target's columns. */
async function insertColumns(view: StatementView, query: Query): Promise<Problem[]> {
  const insert = query.insert;
  if (insert === null) return [];
  const found = await view.lookup.relation(insert.source.qualifier, insert.source.name);
  if (found === null) return [];
  const columns = found.relation.columns.map((column) => column.name);
  const open = view.indexAt(insert.from - 1);
  const problems: Problem[] = [];
  for (const index of view.statement.level(open)) {
    const name = view.name(index);
    if (name === null || columns.some((column) => view.rules.denotes(name, column))) continue;
    const fixes = suggestionFixes(view, name, columns);
    problems.push(problem(RESOLVE, "error", name, `Unable to resolve column '${name.name}'`, fixes));
  }
  return problems;
}

function columnReference(view: StatementView, index: number): "plain" | "qualified" | null {
  const place = view.places[index];
  if (place === undefined || place.clause === null || !COLUMN_CLAUSES.has(place.clause)) return null;
  if (place.clause === USING && place.group === place.queryOpen) return null;
  if (view.isSymbol(index + 1, OPEN) || view.isSymbol(index + 1, DOT)) return null;
  if (view.isSymbol(index - 1, DOT)) {
    const token = view.token(index);
    return token?.kind === "symbol" && view.raw(index) !== STAR ? null : "qualified";
  }
  const next = view.token(index + 1);
  if (next?.kind === "string" || view.word(index - 1) === AS) return null;
  if (isParameter(view, index) || followsOperand(view, index)) return null;
  return "plain";
}

/** Unknown tables, schemas, columns and qualifiers, and columns two sources share (SqlResolve, SqlAmbiguousColumn). */
export async function resolveProblems(view: StatementView): Promise<Problem[]> {
  if (!view.inspected) return [];
  const problems: Problem[] = [];
  for (const query of view.queries.keys()) {
    for (const source of query.sources) {
      if (source.kind === "relation") problems.push(...(await unresolvedRelation(view, query, source)));
    }
    problems.push(...(await insertColumns(view, query)));
  }
  for (let index = 0; index < view.tokens.length; index += 1) {
    const kind = columnReference(view, index);
    if (kind === "qualified") {
      problems.push(...(await qualifiedColumn(view, index)));
      continue;
    }
    const name = kind === null ? null : view.name(index);
    if (name !== null) problems.push(...(await unqualifiedColumn(view, index, name)));
  }
  return problems;
}

function quoteFix(view: StatementView, index: number): Problem | null {
  const token = view.token(index);
  if (token === undefined) return null;
  const raw = view.raw(index);
  const folded = view.rules.fold(raw);
  const fix = replacement(`Quote '${raw}'`, token, view.options.quoteIdentifier(folded));
  return problem(RESERVED, "error", token, `'${raw}' is a reserved word; quote it`, [fix]);
}

function namesRelation(view: StatementView, index: number): boolean {
  const place = view.places[index];
  if (place === undefined || !view.statement.isQuery(place.group) || view.isSymbol(index + 1, OPEN)) return false;
  if (view.isSymbol(index - 1, COMMA))
    return view.places[index - 1]?.clause === FROM_CLAUSE && !CLAUSE_WORDS.has(view.word(index) ?? "");
  const before = view.word(index - 1);
  if (before === null || !RELATION_INTRODUCERS.has(before)) return false;
  return !(before === "UPDATE" && NOT_TABLE_UPDATES.has(view.word(index - 2) ?? ""));
}

/** A reserved word written bare where a table or an inserted column is named (SqlReservedWordAsName). */
export function reservedProblems(view: StatementView): Problem[] {
  if (!view.inspected) return [];
  const listed = new Set<number>();
  for (const query of view.queries.keys()) {
    const insert = query.insert;
    if (insert === null) continue;
    for (const index of view.statement.level(view.indexAt(insert.from - 1))) listed.add(index);
  }
  const problems: Problem[] = [];
  view.tokens.forEach((token, index) => {
    if (token.kind !== "word") return;
    const word = view.raw(index).toUpperCase();
    if (!view.options.reservedWords.has(word) || NOT_RELATION_NAMES.has(word)) return;
    if (!listed.has(index) && !namesRelation(view, index)) return;
    const found = quoteFix(view, index);
    if (found !== null) problems.push(found);
  });
  return problems;
}
