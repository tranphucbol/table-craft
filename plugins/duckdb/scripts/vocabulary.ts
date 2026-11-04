/**
 * Writes `src/vocabulary.generated.ts` from DuckDB's own catalog: every documented function in
 * `duckdb_functions()` and the reserved words of `duckdb_keywords()` (plan 152). Run after the
 * driver pin moves: `bun plugins/duckdb/scripts/vocabulary.ts`. `test/plugins/duckdbLanguage.test.ts`
 * fails when the committed file no longer matches the pinned DuckDB.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FunctionParameter } from "@table-craft/plugin-api";
import type { FunctionCategory, FunctionSpec } from "@table-craft/plugin-api/sql";

const OUTPUT = fileURLToPath(new URL("../src/vocabulary.generated.ts", import.meta.url));
/** More overloads than this crowd the signature popup without telling the reader more. */
const MAX_SIGNATURES = 4;
const SUMMARY_LIMIT = 240;
const NAMED_OPTIONS_AFTER = 3;
const NAMED_OPTION = "option = value";

/** Overloads sort by their content: `function_oid` differs between each system's build. */
const FUNCTIONS_SQL = `
  SELECT function_name, function_type, description, return_type, parameters, varargs, categories
  FROM duckdb_functions()
  WHERE schema_name = 'main'
    AND function_type IN ('scalar', 'aggregate', 'window', 'macro', 'table', 'table_macro')
    AND regexp_matches(function_name, '^[a-z][a-z0-9_]*$')
  ORDER BY function_name, len(parameters), parameters::VARCHAR, parameter_types::VARCHAR, return_type,
    function_type, description`;
const RESERVED_SQL = `SELECT upper(keyword_name) AS word FROM duckdb_keywords() WHERE keyword_category = 'reserved' ORDER BY word`;

/** One row of `duckdb_functions()`, as `getRowObjectsJson` returns it. */
export interface FunctionRow {
  readonly function_name: string;
  readonly function_type: string;
  readonly description: string | null;
  readonly return_type: string | null;
  readonly parameters: readonly string[] | null;
  readonly varargs: string | null;
  readonly categories: readonly string[] | null;
}

export interface Vocabulary {
  readonly version: string;
  readonly functions: readonly FunctionSpec[];
  readonly reservedWords: readonly string[];
}

const CATEGORY_OF: Readonly<Record<string, FunctionCategory>> = {
  string: "string",
  regex: "string",
  text_similarity: "string",
  numeric: "numeric",
  date: "datetime",
  timestamp: "datetime",
  geometry: "spatial",
};

function categoryOf(row: FunctionRow): FunctionCategory {
  if (row.function_type === "aggregate") return "aggregate";
  if (row.function_type === "window") return "window";
  if (row.function_name.startsWith("json")) return "json";
  for (const category of row.categories ?? []) {
    const mapped = CATEGORY_OF[category];
    if (mapped !== undefined) return mapped;
  }
  return "misc";
}

function summaryOf(description: string | null): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_LIMIT) return text;
  const sentence = text.slice(0, SUMMARY_LIMIT).lastIndexOf(". ");
  return sentence > 0 ? text.slice(0, sentence + 1) : `${text.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function returnsOf(row: FunctionRow): string {
  if (row.return_type !== null && row.return_type !== "") return row.return_type;
  return row.function_type === "table" || row.function_type === "table_macro" ? "TABLE" : "ANY";
}

/**
 * `duckdb_functions()` lists a table function's named options (`read_csv(path, header = true)`)
 * as if they were positional, so past a few parameters only the first is positional.
 */
function parametersOf(row: FunctionRow): FunctionParameter[] {
  const listed = row.parameters ?? [];
  const isTable = row.function_type === "table" || row.function_type === "table_macro";
  if (isTable && listed.length > NAMED_OPTIONS_AFTER) {
    return [...listed.slice(0, 1).map((name) => ({ name })), { name: NAMED_OPTION, optional: true, variadic: true }];
  }
  return [
    ...listed.map((name) => ({ name })),
    ...(row.varargs === null ? [] : [{ name: row.varargs.toLowerCase(), variadic: true as const }]),
  ];
}

/** Folds every overload of a name into one spec, the first described overload naming its category. */
export function functionSpecsOf(rows: readonly FunctionRow[]): FunctionSpec[] {
  const byName = new Map<string, { spec: FunctionSpec; seen: Set<string> }>();
  for (const row of rows) {
    const parameters = parametersOf(row);
    const signature = { parameters, returns: returnsOf(row) };
    const shape = parameters.map((parameter) => parameter.name).join(",");
    const name = row.function_name.toUpperCase();
    const entry = byName.get(name);
    if (entry === undefined) {
      byName.set(name, {
        spec: { name, signatures: [signature], summary: summaryOf(row.description), category: categoryOf(row) },
        seen: new Set([shape]),
      });
      continue;
    }
    const summary = entry.spec.summary === "" ? summaryOf(row.description) : entry.spec.summary;
    const keep = !entry.seen.has(shape) && entry.spec.signatures.length < MAX_SIGNATURES;
    entry.seen.add(shape);
    entry.spec = {
      ...entry.spec,
      summary,
      signatures: keep ? [...entry.spec.signatures, signature] : entry.spec.signatures,
    };
  }
  return [...byName.values()].map((entry) => entry.spec);
}

/** Reads the vocabulary from an in-memory DuckDB of the pinned driver. */
export async function readVocabulary(): Promise<Vocabulary> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false" });
  const connection = await instance.connect();
  try {
    const version = String((await connection.runAndReadAll("SELECT version()")).getRows()[0]?.[0]).replace(/^v/, "");
    const functions = (await connection.runAndReadAll(FUNCTIONS_SQL)).getRowObjectsJson() as unknown as FunctionRow[];
    const reserved = (await connection.runAndReadAll(RESERVED_SQL)).getRows().map((row) => String(row[0]));
    return { version, functions: functionSpecsOf(functions), reservedWords: reserved };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** The generated module's text, compared byte for byte by the language test. */
export function renderVocabulary(vocabulary: Vocabulary): string {
  return (
    `// Generated by plugins/duckdb/scripts/vocabulary.ts from DuckDB ${vocabulary.version}; do not edit.\n` +
    `import type { FunctionSpec } from "@table-craft/plugin-api/sql";\n\n` +
    `export const VOCABULARY_VERSION = ${JSON.stringify(vocabulary.version)};\n\n` +
    `export const DUCKDB_FUNCTIONS: readonly FunctionSpec[] = ${JSON.stringify(vocabulary.functions)};\n\n` +
    `export const DUCKDB_RESERVED_WORDS: ReadonlySet<string> = new Set(${JSON.stringify(vocabulary.reservedWords)});\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(OUTPUT, renderVocabulary(await readVocabulary()));
}
