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
  /** Written without parentheses, such as Oracle's `SYSDATE`; the call is the name alone and has no hint. */
  readonly bare?: true;
}

/**
 * `[name, signatures, summary, available?]`, a signature written `"date, format -> string"`, a
 * keyword-led parameter `"unit FROM date -> integer"`, a bare function `"= date"` and a procedure
 * `"str ->"`. A name `PKG.MEMBER` is offered after `pkg.`.
 */
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
const BARE_MARK = "=";
const LEAD_WORD = /^[A-Z][A-Z_]*$/;
const LEAD_CHOICE = "|";
const PARAMETER_SEPARATOR = ",";
const COMMA_SHOWN = ", ";
const MEMBER_SEPARATOR = ".";

function parameter(written: string, lead: string | null): FunctionParameter {
  let name = written.trim();
  const variadic = name.endsWith(VARIADIC_MARK);
  if (variadic) name = name.slice(0, -VARIADIC_MARK.length).trim();
  const optional = name.endsWith(OPTIONAL_MARK);
  if (optional) name = name.slice(0, -OPTIONAL_MARK.length).trim();
  return {
    name,
    ...(optional ? { optional } : {}),
    ...(variadic ? { variadic } : {}),
    ...(lead === null ? {} : { lead }),
  };
}

function isLeadWord(word: string): boolean {
  return word.split(LEAD_CHOICE).every((choice) => LEAD_WORD.test(choice));
}

/** Whether `lead` is `word` or offers it among its `|` alternatives. */
export function leadMatches(lead: string, word: string): boolean {
  return lead.split(LEAD_CHOICE).includes(word);
}

/**
 * One comma-separated part: an upper-case word between names leads the next, as one before the
 * first parameter does; one standing alone is a keyword choice. After a comma the keyword is the
 * argument's own (`date, INTERVAL expr unit`), since the comma already separates it.
 */
function leadParameters(part: string, index: number): FunctionParameter[] {
  const words = part.trim().split(/\s+/);
  const parameters: FunctionParameter[] = [];
  let lead: string | null = null;
  let name: string[] = [];
  const flush = (): void => {
    if (name.length > 0) parameters.push(parameter(name.join(" "), lead));
    name = [];
    lead = null;
  };
  words.forEach((word, at) => {
    const next = words[at + 1];
    const afterComma = at === 0 && index > 0;
    if (!afterComma && isLeadWord(word) && next !== undefined && !isLeadWord(next)) {
      flush();
      lead = word;
    } else name.push(word);
  });
  flush();
  return parameters;
}

function isBareSignature(written: string): boolean {
  return written.trim().startsWith(BARE_MARK);
}

/**
 * Reads `"str, len? -> string"`: `?` marks an optional parameter, `...` one that repeats, an
 * upper-case word between names the keyword before the next (`"unit FROM date -> integer"`).
 * `"= date"` is a bare function's and `"str ->"` a procedure's, which returns nothing.
 */
export function parseSignature(written: string): FunctionSignature {
  if (isBareSignature(written)) return { parameters: [], returns: written.trim().slice(BARE_MARK.length).trim() };
  const arrow = written.lastIndexOf(RETURNS_ARROW);
  if (arrow < 0) throw new Error(`Signature "${written}" has no "${RETURNS_ARROW} type"; add what it returns.`);
  const list = written.slice(0, arrow).trim();
  return {
    parameters: list === "" ? [] : list.split(PARAMETER_SEPARATOR).flatMap(leadParameters),
    returns: written.slice(arrow + RETURNS_ARROW.length).trim(),
  };
}

/** Specs for one category, from compact entries a plugin's data file lists. */
export function functionSpecs(category: FunctionCategory, entries: readonly FunctionEntry[]): FunctionSpec[] {
  return entries.map(([name, signatures, summary, available]) => {
    const written = typeof signatures === "string" ? [signatures] : signatures;
    const bare = written.filter(isBareSignature).length;
    if (bare > 0 && bare < written.length)
      throw new Error(`${name} mixes "${BARE_MARK} type" with called signatures; write the bare form as "-> type".`);
    return {
      name,
      signatures: written.map(parseSignature),
      summary,
      category,
      ...(available === undefined ? {} : { available }),
      ...(bare > 0 ? { bare: true as const } : {}),
    };
  });
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

function shownParameter(parameter: FunctionParameter, index: number): string {
  const name = parameter.variadic === true ? `${parameter.name}${VARIADIC_MARK}` : parameter.name;
  const led = parameter.lead === undefined ? name : `${parameter.lead} ${name}`;
  const separator = index === 0 ? "" : parameter.lead === undefined ? COMMA_SHOWN : " ";
  return separator + (parameter.optional === true ? `[${led}]` : led);
}

function returnsLabel(returns: string): string {
  return returns === "" ? "" : `${SHOWN_ARROW} ${returns}`;
}

/** `(date, format) → string`, the popup's detail for one signature; a lead replaces the comma, a procedure has no `→`. */
export function signatureLabel(signature: FunctionSignature): string {
  const list = `(${signature.parameters.map(shownParameter).join("")})`;
  const returns = returnsLabel(signature.returns);
  return returns === "" ? list : `${list} ${returns}`;
}

function shownSignature(spec: FunctionSpec, signature: FunctionSignature): string {
  return spec.bare === true ? returnsLabel(signature.returns) : signatureLabel(signature);
}

/** Every signature on its own line, then the summary. */
export function functionInfo(spec: FunctionSpec): string {
  const label = spec.name.toLowerCase();
  const gap = spec.bare === true ? " " : "";
  const lines = spec.signatures.map((signature) => `${label}${gap}${shownSignature(spec, signature)}`);
  return `${lines.join("\n")}\n\n${spec.summary}`;
}

/**
 * A spec as an item: `name()` with the caret between the parentheses when it takes arguments, or
 * the name alone for a bare one. `label` is what the popup offers, the member alone after `pkg.`.
 */
function specItem(spec: FunctionSpec, label: string, boost: number): CompletionItem {
  const first = spec.signatures[0];
  const takesArguments = spec.signatures.some((signature) => signature.parameters.length > 0);
  const bare = spec.bare === true;
  return {
    label,
    kind: "function",
    detail: first === undefined ? null : shownSignature(spec, first),
    apply: bare ? label : `${label}()`,
    boost,
    info: functionInfo(spec),
    caret: takesArguments && !bare ? label.length + 1 : null,
  };
}

/** A spec as an item: `name()` with the caret between the parentheses when it takes arguments, the name alone when bare. */
export function functionItem(spec: FunctionSpec | string, boost: number): CompletionItem {
  if (typeof spec === "string")
    return { label: spec, kind: "function", detail: null, apply: spec, boost, info: null, caret: null };
  return specItem(spec, spec.name.toLowerCase(), boost);
}

/** The package a spec named `PKG.MEMBER` belongs to, upper case; null for a plain function. */
export function functionPackage(spec: FunctionSpec | string): string | null {
  const name = functionName(spec);
  const dot = name.lastIndexOf(MEMBER_SEPARATOR);
  return dot < 0 ? null : name.slice(0, dot).toUpperCase();
}

/** A package member as offered after `pkg.`: the member's name alone, the info naming it in full. */
export function memberItem(spec: FunctionSpec, boost: number): CompletionItem {
  return specItem(spec, spec.name.slice(spec.name.lastIndexOf(MEMBER_SEPARATOR) + 1).toLowerCase(), boost);
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
