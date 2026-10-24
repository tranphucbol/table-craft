import type { CompletionItem, FunctionParameter, FunctionSignature } from "@table-craft/plugin-api";

/** Where a function belongs in the server's manual; it groups the data, the popup does not show it. */
export const FUNCTION_CATEGORIES = [
  "string",
  "numeric",
  "datetime",
  "json",
  "aggregate",
  "window",
  "information",
  "encryption",
  "locking",
  "spatial",
  "xml",
  "control",
  "misc",
  "server",
] as const;

export type FunctionCategory = (typeof FUNCTION_CATEGORIES)[number];

/**
 * The versions of each server flavour a function exists in: space-separated comparators all of which
 * hold, such as `">=5.7.22 <8.0"`, or `false` for none. A flavour it does not name has it in every
 * version (decision 097).
 */
export type ServerRange = Readonly<Record<string, string | false>>;

/** A server as completion reads it: the plugin's name for its flavour and the version in it. */
export interface ServerIdentity {
  readonly flavour: string;
  readonly version: readonly number[];
}

/** A built-in function a plugin documents (decision 097). */
export interface FunctionSpec {
  /** As the manual writes it, upper case; the popup offers it lower case. */
  readonly name: string;
  readonly signatures: readonly FunctionSignature[];
  readonly summary: string;
  readonly category: FunctionCategory;
  readonly available?: ServerRange;
}

/** `[name, signatures, summary, available?]`, a signature written `"date, format -> string"`. */
export type FunctionEntry = readonly [
  name: string,
  signatures: string | readonly string[],
  summary: string,
  available?: ServerRange,
];

const RETURNS_ARROW = "->";
const SHOWN_ARROW = "→";
const OPTIONAL_MARK = "?";
const VARIADIC_MARK = "...";
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/;

function parameter(written: string): FunctionParameter {
  let name = written.trim();
  const variadic = name.endsWith(VARIADIC_MARK);
  if (variadic) name = name.slice(0, -VARIADIC_MARK.length).trim();
  const optional = name.endsWith(OPTIONAL_MARK);
  if (optional) name = name.slice(0, -OPTIONAL_MARK.length).trim();
  return { name, ...(optional ? { optional } : {}), ...(variadic ? { variadic } : {}) };
}

/** Reads `"str, len? -> string"`: `?` marks an optional parameter, `...` one that repeats. */
export function parseSignature(written: string): FunctionSignature {
  const arrow = written.lastIndexOf(RETURNS_ARROW);
  if (arrow < 0) throw new Error(`Signature "${written}" has no "${RETURNS_ARROW} type"; add what it returns.`);
  const list = written.slice(0, arrow).trim();
  return {
    parameters: list === "" ? [] : list.split(",").map(parameter),
    returns: written.slice(arrow + RETURNS_ARROW.length).trim(),
  };
}

/** Specs for one category, from compact entries a plugin's data file lists. */
export function functionSpecs(category: FunctionCategory, entries: readonly FunctionEntry[]): FunctionSpec[] {
  return entries.map(([name, signatures, summary, available]) => ({
    name,
    signatures: (typeof signatures === "string" ? [signatures] : signatures).map(parseSignature),
    summary,
    category,
    ...(available === undefined ? {} : { available }),
  }));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function satisfies(version: readonly number[], comparator: string): boolean {
  const match = COMPARATOR.exec(comparator);
  if (match === null) throw new Error(`Version comparator "${comparator}" is not like ">=8.0.4"; fix the range.`);
  const order = compareVersions(version, (match[2] ?? "").split(".").map(Number));
  switch (match[1]) {
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    default:
      return order === 0;
  }
}

/** Whether `spec` exists on `server`; an unknown server has every function any flavour has. */
export function isAvailable(spec: FunctionSpec, server: ServerIdentity | null): boolean {
  if (spec.available === undefined || server === null) return true;
  const range = spec.available[server.flavour];
  if (range === undefined) return true;
  if (range === false) return false;
  return range
    .split(/\s+/)
    .filter((comparator) => comparator !== "")
    .every((comparator) => satisfies(server.version, comparator));
}

function shownParameter(parameter: FunctionParameter): string {
  const name = parameter.variadic === true ? `${parameter.name}${VARIADIC_MARK}` : parameter.name;
  return parameter.optional === true ? `[${name}]` : name;
}

/** `(date, format) → string`, the popup's detail for one signature. */
export function signatureLabel(signature: FunctionSignature): string {
  return `(${signature.parameters.map(shownParameter).join(", ")}) ${SHOWN_ARROW} ${signature.returns}`;
}

/** Every signature on its own line, then the summary. */
export function functionInfo(spec: FunctionSpec): string {
  const label = spec.name.toLowerCase();
  const lines = spec.signatures.map((signature) => `${label}${signatureLabel(signature)}`);
  return `${lines.join("\n")}\n\n${spec.summary}`;
}

/** A spec as an item: `name()` with the caret between the parentheses when it takes arguments. */
export function functionItem(spec: FunctionSpec | string, boost: number): CompletionItem {
  if (typeof spec === "string")
    return { label: spec, kind: "function", detail: null, apply: spec, boost, info: null, caret: null };
  const label = spec.name.toLowerCase();
  const first = spec.signatures[0];
  const takesArguments = spec.signatures.some((signature) => signature.parameters.length > 0);
  return {
    label,
    kind: "function",
    detail: first === undefined ? null : signatureLabel(first),
    apply: `${label}()`,
    boost,
    info: functionInfo(spec),
    caret: takesArguments ? label.length + 1 : null,
  };
}

/** The name a function entry is offered under, either form. */
export function functionName(spec: FunctionSpec | string): string {
  return typeof spec === "string" ? spec : spec.name;
}

/** Aggregate and scalar functions every built-in dialect has; a plugin adds its own. Written in our own words. */
export const SQL_FUNCTIONS: readonly FunctionSpec[] = [
  ...functionSpecs("aggregate", [
    ["AVG", "expr -> number", "The mean of the non-null values in the group."],
    ["COUNT", ["* -> integer", "expr -> integer"], "How many rows the group has, or how many give a non-null value."],
    ["MAX", "expr -> value", "The largest value in the group."],
    ["MIN", "expr -> value", "The smallest value in the group."],
    ["SUM", "expr -> number", "The total of the values in the group."],
  ]),
  ...functionSpecs("numeric", [
    ["ABS", "x -> number", "The value without its sign."],
    ["ROUND", "x, digits? -> number", "Rounds to the given number of decimal places, zero by default."],
  ]),
  ...functionSpecs("string", [
    ["LENGTH", "str -> integer", "How long the string is."],
    ["LOWER", "str -> string", "The string in lower case."],
    ["REPLACE", "str, from, to -> string", "Swaps every occurrence of one substring for another."],
    [
      "SUBSTR",
      "str, start, length? -> string",
      "Part of the string from a 1-based position, optionally of a set length.",
    ],
    ["TRIM", "str -> string", "The string without spaces at either end."],
    ["UPPER", "str -> string", "The string in upper case."],
  ]),
  ...functionSpecs("control", [
    ["CAST", "expr AS type -> value", "Converts a value to another type."],
    ["COALESCE", "value... -> value", "The first argument that is not null."],
    ["NULLIF", "a, b -> value", "Null when both arguments are equal, else the first."],
  ]),
];
