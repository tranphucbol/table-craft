import type { ColumnMeta, NamespaceCatalog, Relation } from "@table-craft/plugin-api";
import { columnTypeClass } from "@table-craft/core/results/compare.js";

/** A foreign key the names and types suggest but the database never declared (plan 152). */
export interface InferredKey {
  /** Stable across runs: `relation(columns)->target(columns)`, the id hide and keep refer to. */
  readonly id: string;
  readonly relation: string;
  readonly columns: readonly string[];
  readonly target: { readonly relation: string; readonly columns: readonly string[] };
}

const BARE_ID = "id";
const SELF_REFERENCE_STEMS = ["parent"] as const;
const PLURAL_SUFFIXES = ["", "s", "es"] as const;
const Y_SINGULAR = "y";
const Y_PLURAL = "ies";
const SEPARATORS = /[\s_-]+/u;
const LOWER_TO_UPPER = /(\p{Ll}|\p{Nd})(\p{Lu})/gu;
const ACRONYM_TO_WORD = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;

/** `customerId`, `CustomerID` and `customer_id` all read as `["customer", "id"]`. */
export function nameTokens(name: string): string[] {
  return name
    .replace(ACRONYM_TO_WORD, "$1 $2")
    .replace(LOWER_TO_UPPER, "$1 $2")
    .split(SEPARATORS)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

interface Target {
  readonly relation: Relation;
  readonly tokens: readonly string[];
  readonly column: ColumnMeta;
  readonly columnTokens: readonly string[];
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function pluralForms(token: string): string[] {
  const forms = PLURAL_SUFFIXES.map((suffix) => token + suffix);
  if (token.endsWith(Y_SINGULAR)) forms.push(token.slice(0, -Y_SINGULAR.length) + Y_PLURAL);
  return forms;
}

/** Whether `stem` names a table, its last word in any of the plural forms the rule knows. */
function namesTable(stem: readonly string[], table: readonly string[]): boolean {
  if (stem.length === 0 || stem.length !== table.length) return false;
  const last = stem.length - 1;
  if (!stem.slice(0, last).every((token, index) => token === table[index])) return false;
  return pluralForms(stem[last] ?? "").includes(table[last] ?? "");
}

function columnNamed(relation: Relation, name: string): ColumnMeta | undefined {
  return relation.columns.find((column) => column.name === name);
}

/** The one column a reference can point at: a sole-column primary key, failing that a sole single-column unique key. */
function keyColumn(relation: Relation): ColumnMeta | undefined {
  const primary = relation.primaryKey;
  if (primary !== null) {
    return primary.columns.length === 1 ? columnNamed(relation, primary.columns[0] ?? "") : undefined;
  }
  const single = relation.uniqueKeys.filter((key) => key.columns.length === 1);
  return single.length === 1 ? columnNamed(relation, single[0]?.columns[0] ?? "") : undefined;
}

function typeClassOf(column: ColumnMeta): string {
  return columnTypeClass({ type: column.type });
}

/** The tables `tokens` matches, each with how long the stem that named it is: longer wins. */
function matches(column: ColumnMeta, source: Relation, targets: readonly Target[]): Map<number, Target[]> {
  const tokens = nameTokens(column.name);
  const found = new Map<number, Target[]>();
  const add = (length: number, target: Target): void => {
    found.set(length, [...(found.get(length) ?? []), target]);
  };
  // `CustomerID` as the key of both `Customers` and `CustomerDemographics` would point each at the other.
  const isOwnKey = source.primaryKey !== null && keyColumn(source) === column;
  for (const target of targets) {
    if (target.relation === source) continue;
    const suffix = target.columnTokens;
    const bareId = sameTokens(suffix, [BARE_ID]);
    if (!bareId && sameTokens(tokens, suffix) && !isOwnKey) {
      add(0, target);
      continue;
    }
    if (tokens.length <= suffix.length || !sameTokens(tokens.slice(tokens.length - suffix.length), suffix)) continue;
    const stem = tokens.slice(0, tokens.length - suffix.length);
    for (let dropped = 0; dropped < stem.length; dropped += 1) {
      const shorter = stem.slice(dropped);
      if (namesTable(shorter, target.tokens)) {
        add(shorter.length, target);
        break;
      }
    }
  }
  return found;
}

function selfReference(relation: Relation, column: ColumnMeta): ColumnMeta | undefined {
  const key = keyColumn(relation);
  if (relation.primaryKey === null || key?.name !== BARE_ID) return undefined;
  const tokens = nameTokens(column.name);
  const isSelf = SELF_REFERENCE_STEMS.some((stem) => sameTokens(tokens, [...nameTokens(stem), BARE_ID]));
  return isSelf ? key : undefined;
}

function keyId(relation: string, columns: readonly string[], target: string, targetColumns: readonly string[]): string {
  return `${relation}(${columns.join(",")})->${target}(${targetColumns.join(",")})`;
}

function inferred(relation: Relation, column: ColumnMeta, target: Relation, targetColumn: ColumnMeta): InferredKey {
  return {
    id: keyId(relation.name, [column.name], target.name, [targetColumn.name]),
    relation: relation.name,
    columns: [column.name],
    target: { relation: target.name, columns: [targetColumn.name] },
  };
}

/**
 * The foreign keys `catalog` implies by name and type but does not declare (plan 152, the
 * inference rule). Conservative by design: an ambiguous column yields no key rather than a pick,
 * views are never a source or a target, and inference stays inside the namespace.
 */
export function inferForeignKeys(catalog: NamespaceCatalog): InferredKey[] {
  const tables = catalog.relations.filter((relation) => relation.kind === "table");
  const targets: Target[] = [];
  for (const relation of tables) {
    const column = keyColumn(relation);
    if (column === undefined) continue;
    targets.push({ relation, tokens: nameTokens(relation.name), column, columnTokens: nameTokens(column.name) });
  }
  const keys: InferredKey[] = [];
  for (const relation of tables) {
    const declared = new Set(
      relation.foreignKeys.filter((key) => key.columns.length === 1).map((key) => key.columns[0] ?? ""),
    );
    for (const column of relation.columns) {
      if (declared.has(column.name)) continue;
      const self = selfReference(relation, column);
      if (self !== undefined) {
        if (typeClassOf(self) === typeClassOf(column)) keys.push(inferred(relation, column, relation, self));
        continue;
      }
      const found = matches(column, relation, targets);
      if (found.size === 0) continue;
      const winners = found.get(Math.max(...found.keys())) ?? [];
      const [winner] = winners;
      if (winners.length !== 1 || winner === undefined) continue;
      if (typeClassOf(winner.column) !== typeClassOf(column)) continue;
      keys.push(inferred(relation, column, winner.relation, winner.column));
    }
  }
  return keys.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
