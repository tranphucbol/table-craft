import type { ExportEncoder } from "@table-craft/core";
import type { NamespaceCatalog, RelationKind, Row } from "@table-craft/plugin-api";
import { EngineFailure, messageOf } from "@table-craft/desktop/engine/failures.js";
import { SCRIPT_RELATION_KINDS, type SchemaScript } from "@table-craft/desktop/engine/protocol.js";

const BYTES_PER_MIB = 1024 * 1024;
/** Larger than any schema a console or the clipboard holds comfortably; the File target streams instead. */
export const MAX_SCRIPT_TEXT_BYTES = 8 * BYTES_PER_MIB;
export const SCRIPT_TOO_LARGE_HINT = "Choose Generate DDL to File… for a schema this size.";
const STATEMENT_SEPARATOR = "\n\n";
const COMMENT = "-- ";
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const NOT_INCLUDED = "Routines and sequences are not included.";

/** A relation as the script orders it: tables it references inside the namespace, by name. */
export interface ScriptRelation {
  readonly name: string;
  readonly kind: RelationKind;
  readonly references: readonly string[];
}

export interface ScriptOrder {
  readonly order: readonly ScriptRelation[];
  /** Tables that reference each other, each group in name order; their order is name order. */
  readonly cycles: readonly (readonly string[])[];
}

export interface ScriptHeaderInput {
  /** The datasource's name; the engine does not know it. */
  readonly title: string;
  readonly path: readonly string[];
  readonly generatedAt: number;
  readonly cycles: ScriptOrder["cycles"];
}

/** One relation's place in the script: its definition, or the reason it could not be read. */
export type ScriptPiece =
  { readonly name: string; readonly definition: string } | { readonly name: string; readonly error: string };

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/** The relations of `kinds` in `catalog`, each with the tables of the same namespace its foreign keys reference. */
export function scriptRelations(catalog: NamespaceCatalog, kinds: readonly RelationKind[]): ScriptRelation[] {
  const here = JSON.stringify(catalog.path);
  return catalog.relations
    .filter((relation) => kinds.includes(relation.kind))
    .map((relation) => ({
      name: relation.name,
      kind: relation.kind,
      references: relation.foreignKeys
        .filter((key) => JSON.stringify(key.target.path) === here)
        .map((key) => key.target.relation),
    }));
}

/** Groups of two or more tables that reach each other through foreign keys (Tarjan). */
function cyclesOf(tables: readonly ScriptRelation[], edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;
  function visit(name: string): void {
    index.set(name, next);
    low.set(name, next);
    next += 1;
    stack.push(name);
    onStack.add(name);
    for (const target of edges.get(name) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(name, Math.min(low.get(name) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(name, Math.min(low.get(name) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(name) !== index.get(name)) return;
    const group: string[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      group.push(member);
      if (member === name) break;
    }
    if (group.length > 1) cycles.push(group.sort());
  }
  for (const table of tables) if (!index.has(table.name)) visit(table.name);
  return cycles.sort((a, b) => byName({ name: a[0] ?? "" }, { name: b[0] ?? "" }));
}

/**
 * Tables first, each after the tables it references, ties by name; then views, then
 * materialized views, by name. Where tables reference each other the first by name goes next.
 */
export function orderForScript(relations: readonly ScriptRelation[]): ScriptOrder {
  const tables = relations.filter((relation) => relation.kind === "table").sort(byName);
  const names = new Set(tables.map((table) => table.name));
  const edges = new Map(
    tables.map((table) => [
      table.name,
      [...new Set(table.references)].filter((target) => target !== table.name && names.has(target)),
    ]),
  );
  const waiting = new Map(tables.map((table) => [table.name, new Set(edges.get(table.name))]));
  const order: ScriptRelation[] = [];
  const remaining = [...tables];
  while (remaining.length > 0) {
    const ready = remaining.findIndex((table) => waiting.get(table.name)?.size === 0);
    const [table] = remaining.splice(ready === -1 ? 0 : ready, 1);
    if (table === undefined) break;
    order.push(table);
    for (const pending of waiting.values()) pending.delete(table.name);
  }
  const rest = SCRIPT_RELATION_KINDS.filter((kind) => kind !== "table").flatMap((kind) =>
    relations.filter((relation) => relation.kind === kind).sort(byName),
  );
  return { order: [...order, ...rest], cycles: cyclesOf(tables, edges) };
}

/** `orders and invoices`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export function scriptHeader(input: ScriptHeaderInput): string {
  const generated = new Date(input.generatedAt).toISOString().slice(0, ISO_DATE_LENGTH);
  return [
    `${input.title}: ${input.path.join(".")}`,
    `Generated by TableCraft on ${generated}`,
    NOT_INCLUDED,
    ...input.cycles.map((cycle) => `${listed(cycle)} reference each other; create them with foreign key checks off.`),
  ]
    .map((line) => `${COMMENT}${line}`)
    .join("\n");
}

/** A piece as the script writes it after the header, its separator first. */
export function pieceText(piece: ScriptPiece): string {
  const body = "definition" in piece ? piece.definition.trimEnd() : `${COMMENT}${piece.name}: ${piece.error}`;
  return `${STATEMENT_SEPARATOR}${body}`;
}

/** The end of every script, so the file ends in a newline. */
export const SCRIPT_END = "\n";

export function assembleScript(header: string, pieces: readonly ScriptPiece[]): string {
  return `${header}${pieces.map(pieceText).join("")}${SCRIPT_END}`;
}

export interface ScriptSource {
  describe(path: readonly string[]): Promise<NamespaceCatalog>;
  definition(path: readonly string[], name: string): Promise<string>;
  now(): number;
}

export interface ScriptRequest {
  readonly path: readonly string[];
  readonly kinds: readonly RelationKind[];
  readonly title: string;
}

/** The header and the order of a namespace's script, from its cached catalog. */
export async function planScript(
  source: ScriptSource,
  request: ScriptRequest,
): Promise<{ header: string; order: readonly ScriptRelation[] }> {
  const catalog = await source.describe(request.path);
  const { order, cycles } = orderForScript(scriptRelations(catalog, request.kinds));
  const header = scriptHeader({ title: request.title, path: request.path, generatedAt: source.now(), cycles });
  return { header, order };
}

/** A relation's piece: a definition the database refuses becomes a comment in its place. */
export async function pieceOf(source: ScriptSource, path: readonly string[], name: string): Promise<ScriptPiece> {
  try {
    return { name, definition: await source.definition(path, name) };
  } catch (cause) {
    const message = cause instanceof EngineFailure ? cause.error.message : messageOf(cause);
    return { name, error: message.replaceAll("\n", " ") };
  }
}

/** The whole script in memory, refused once it outgrows `maxBytes`. */
export async function scriptNamespace(
  source: ScriptSource,
  request: ScriptRequest,
  maxBytes: number = MAX_SCRIPT_TEXT_BYTES,
): Promise<SchemaScript> {
  const { header, order } = await planScript(source, request);
  const encoder = new TextEncoder();
  let bytes = encoder.encode(header).length;
  const pieces: ScriptPiece[] = [];
  for (const relation of order) {
    const piece = await pieceOf(source, request.path, relation.name);
    bytes += encoder.encode(pieceText(piece)).length;
    if (bytes > maxBytes) {
      throw new EngineFailure({
        code: "scriptTooLarge",
        message: `The DDL of ${request.path.join(".")} is larger than ${String(maxBytes / BYTES_PER_MIB)} MiB.`,
        hint: SCRIPT_TOO_LARGE_HINT,
      });
    }
    pieces.push(piece);
  }
  return {
    text: assembleScript(header, pieces),
    relations: pieces.length,
    failed: pieces.filter((piece) => "error" in piece).length,
  };
}

/** One row per relation, its piece as the script writes it, read only when the export asks for it. */
export async function* scriptRows(
  source: ScriptSource,
  path: readonly string[],
  order: readonly ScriptRelation[],
): AsyncGenerator<Row> {
  for (const relation of order) yield [pieceText(await pieceOf(source, path, relation.name))];
}

/** Writes what `assembleScript` would, a piece at a time: the header, each row's text, the end. */
export function scriptEncoder(header: string): ExportEncoder {
  return {
    start: () => header,
    row: ([text]) => (typeof text === "string" ? text : ""),
    end: () => SCRIPT_END,
    sheets: 0,
    truncatedCells: 0,
  };
}
