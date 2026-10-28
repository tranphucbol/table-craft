const JSON_INDENT = 2;
const MISSING = Symbol("missing");
const JSON_TOKENS = /"(?:\\.|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = Json | typeof MISSING;

export interface MergeConflict {
  readonly path: string;
  readonly theirs: string;
  readonly yours: string;
}

export interface KeyMerge {
  readonly text: string;
  readonly conflicts: readonly MergeConflict[];
  readonly automatic: number;
  readonly format: "json" | "text";
}

export type MergeChoices = Readonly<Record<string, "theirs" | "yours">>;

/** Fall back to byte-preserving text when JavaScript would rewrite a numeric literal. */
export function parseKeyJson(text: string): Json {
  for (const token of text.matchAll(JSON_TOKENS)) {
    const number = token[1];
    if (number !== undefined && JSON.stringify(Number(number)) !== number)
      throw new Error("Number cannot round-trip safely");
  }
  return JSON.parse(text) as Json;
}

function same(a: Node, b: Node): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (object(a) && object(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key] ?? null, b[key] ?? null))
    );
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function object(value: Node): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: Node): string {
  return value === MISSING ? "(removed)" : JSON.stringify(value);
}

/** Objects merge by JSON pointer, arrays atomically. Missing members are distinct from null. */
export function mergeKeyText(base: string | null, theirs: string, yours: string, choices: MergeChoices = {}): KeyMerge {
  if (base === null) {
    const choice = choices[""];
    return {
      text: choice === "theirs" ? theirs : yours,
      conflicts: theirs === yours || choice !== undefined ? [] : [{ path: "", theirs, yours }],
      automatic: 0,
      format: "text",
    };
  }
  const conflicts: MergeConflict[] = [];
  let automatic = 0;
  function merge(a: Node, b: Node, c: Node, path: string): Node {
    if (same(b, c)) return b;
    if (same(a, b)) {
      automatic++;
      return c;
    }
    if (same(a, c)) {
      automatic++;
      return b;
    }
    if (object(a) && object(b) && object(c)) {
      const result: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
      for (const key of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)])) {
        const read = (node: { [key: string]: Json }): Node =>
          Object.hasOwn(node, key) ? (node[key] ?? null) : MISSING;
        const next = merge(read(a), read(b), read(c), `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
        if (next !== MISSING) result[key] = next;
      }
      return result;
    }
    const choice = choices[path];
    if (choice === undefined) conflicts.push({ path, theirs: describe(b), yours: describe(c) });
    return choice === "theirs" ? b : c;
  }
  try {
    const a = parseKeyJson(base);
    const b = parseKeyJson(theirs);
    const c = parseKeyJson(yours);
    const result = merge(a, b, c, "");
    return {
      text: JSON.stringify(result === MISSING ? null : result, null, JSON_INDENT),
      conflicts,
      automatic,
      format: "json",
    };
  } catch {
    if (theirs === yours) return { text: yours, conflicts: [], automatic: 0, format: "text" };
    if (base === theirs) return { text: yours, conflicts: [], automatic: 1, format: "text" };
    if (base === yours) return { text: theirs, conflicts: [], automatic: 1, format: "text" };
    const a = base.split("\n");
    const b = theirs.split("\n");
    const c = yours.split("\n");
    // Without a common line alignment, choosing a whole value is safer than guessing where an insertion belongs.
    if (a.length !== b.length || a.length !== c.length) {
      const choice = choices[""];
      return {
        text: choice === "theirs" ? theirs : yours,
        conflicts: choice === undefined ? [{ path: "", theirs, yours }] : [],
        automatic: 0,
        format: "text",
      };
    }
    const lines = a.map((line, index) => {
      const bt = b[index] ?? "";
      const ct = c[index] ?? "";
      if (bt === ct) return bt;
      if (line === bt) {
        automatic++;
        return ct;
      }
      if (line === ct) {
        automatic++;
        return bt;
      }
      const path = `Line ${String(index + 1)}`;
      if (choices[path] === undefined) conflicts.push({ path, theirs: bt, yours: ct });
      return choices[path] === "theirs" ? bt : ct;
    });
    return { text: lines.join("\n"), conflicts, automatic, format: "text" };
  }
}
