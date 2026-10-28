import { PluginError, type ExplainedPlan, type PlanNode, type PlanProperty } from "@table-craft/plugin-api";

/** What `SET SHOWPLAN_XML` plans; `SET STATISTICS XML` runs and reports the same statements. */
export const EXPLAIN_VERBS = ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"];

const SHOWPLAN_ON = "SET SHOWPLAN_XML ON";
const SHOWPLAN_OFF = "SET SHOWPLAN_XML OFF";
const STATISTICS_ON = "SET STATISTICS XML ON";
const STATISTICS_OFF = "SET STATISTICS XML OFF";

/** The batches an explain sends: each `SET` must be alone in its batch. */
export function explainBatches(sql: string, analyze: boolean): { on: string; off: string; statement: string } {
  const [on, off] = analyze ? [STATISTICS_ON, STATISTICS_OFF] : [SHOWPLAN_ON, SHOWPLAN_OFF];
  return { on, off, statement: `${on};\n${sql};\n${off};` };
}

/** The column `SET SHOWPLAN_XML` and `SET STATISTICS XML` name their one-row result by. */
export const PLAN_COLUMN = /^Microsoft SQL Server \d+ XML Showplan$/;

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decoded(text: string): string {
  return text.replace(ENTITY, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
}

interface Building {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

/** The elements and attributes of a showplan: text between tags is not part of one, so it is dropped. */
export function parseXml(xml: string): XmlElement {
  const root: Building = { name: "", attributes: {}, children: [] };
  const open: Building[] = [root];
  for (const match of xml.matchAll(TAG)) {
    const [, closing, name, attributeText, selfClosing] = match;
    if (name === undefined) continue;
    const parent = open.at(-1) ?? root;
    if (closing === "/") {
      if (open.length > 1) open.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of (attributeText ?? "").matchAll(ATTRIBUTE)) {
      const [, key, double, single] = attribute;
      if (key !== undefined) attributes[key] = decoded(double ?? single ?? "");
    }
    const element: Building = { name: localName(name), attributes, children: [] };
    parent.children.push(element);
    if (selfClosing !== "/") open.push(element);
  }
  return root;
}

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

function descendants(element: XmlElement, name: string, stopAt: string | null = null): XmlElement[] {
  return element.children.flatMap((child) =>
    child.name === name ? [child] : child.name === stopAt ? [] : descendants(child, name, stopAt),
  );
}

const RELOP = "RelOp";
const MAPPED = new Set([
  "PhysicalOp",
  "LogicalOp",
  "EstimateRows",
  "EstimatedTotalSubtreeCost",
  "NodeId",
  "EstimatedRowsRead",
]);

function number(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unbracketed(name: string | undefined): string | null {
  return name === undefined ? null : name.replace(/^\[|\]$/g, "").replaceAll("]]", "]");
}

/** The table a step reads, as `schema.table alias`, and the index it uses. */
function objectOf(relop: XmlElement): { target: string | null; index: string | null } {
  const object = descendants(relop, "Object", RELOP)[0];
  if (object === undefined) return { target: null, index: null };
  const { Schema: schema, Table: table, Alias: alias, Index: index } = object.attributes;
  const tableName = unbracketed(table);
  const qualified =
    tableName === null ? null : [unbracketed(schema), tableName].filter((part) => part !== null).join(".");
  const shownAlias = unbracketed(alias);
  return {
    target:
      qualified === null
        ? null
        : shownAlias === null || shownAlias === tableName
          ? qualified
          : `${qualified} ${shownAlias}`,
    index: unbracketed(index),
  };
}

/** `RunTimeCountersPerThread`, summed over threads: rows and executions add up, time is the longest. */
function actuals(relop: XmlElement): { rows: number | null; loops: number | null; timeMs: number | null } {
  const runtime = relop.children.find((child) => child.name === "RunTimeInformation");
  const threads = runtime?.children.filter((child) => child.name === "RunTimeCountersPerThread") ?? [];
  if (threads.length === 0) return { rows: null, loops: null, timeMs: null };
  const sum = (key: string): number =>
    threads.reduce((total, thread) => total + (number(thread.attributes[key]) ?? 0), 0);
  const times = threads.map((thread) => number(thread.attributes.ActualElapsedms)).filter((time) => time !== null);
  return {
    rows: sum("ActualRows"),
    loops: sum("ActualExecutions"),
    timeMs: times.length === 0 ? null : Math.max(...times),
  };
}

/** The conditions a step applies, as the server spells them in `ScalarString`. */
const CONDITIONS = [
  ["Predicate", "Predicate"],
  ["SeekPredicates", "Seek Predicate"],
] as const;

function conditionsOf(relop: XmlElement): PlanProperty[] {
  return CONDITIONS.flatMap(([element, label]) =>
    descendants(relop, element, RELOP).flatMap((found) => {
      const strings = descendants(found, "ScalarOperator")
        .map((operator) => operator.attributes.ScalarString)
        .filter((text): text is string => text !== undefined);
      return strings.length === 0 ? [] : [{ name: label, value: strings.join(" AND ") }];
    }),
  );
}

function planNode(relop: XmlElement): PlanNode {
  const { PhysicalOp: physical, LogicalOp: logical } = relop.attributes;
  const operation = physical ?? logical ?? RELOP;
  const { target, index } = objectOf(relop);
  const actual = actuals(relop);
  const properties: PlanProperty[] = [
    ...conditionsOf(relop),
    ...Object.entries(relop.attributes)
      .filter(([name]) => !MAPPED.has(name))
      .map(([name, value]) => ({ name, value })),
  ];
  return {
    operation: logical !== undefined && logical !== operation ? `${operation} (${logical})` : operation,
    target,
    detail: index === null ? null : `using ${index}`,
    estimatedRows: number(relop.attributes.EstimateRows),
    estimatedCost: number(relop.attributes.EstimatedTotalSubtreeCost),
    actualRows: actual.rows,
    actualTimeMs: actual.timeMs,
    loops: actual.loops,
    properties,
    children: descendants(relop, RELOP, RELOP).flatMap((child) => (child === relop ? [] : [planNode(child)])),
  };
}

function childRelops(element: XmlElement): XmlElement[] {
  return element.children.flatMap((child) => (child.name === RELOP ? [child] : childRelops(child)));
}

/** An analysed run's `QueryTimeStats`, in milliseconds. */
const TIME_KEYS = [
  ["CpuTime", "CPU Time"],
  ["ElapsedTime", "Elapsed Time"],
] as const;
/** The statement's facts the plan's top states once: its type, cost, rows and how it was optimised. */
const SUMMARY_KEYS = [
  "StatementType",
  "StatementSubTreeCost",
  "StatementEstRows",
  "StatementOptmLevel",
  "CardinalityEstimationModelVersion",
];

/** Reads the XML showplan: each statement's top operator, and the statements' own facts as the summary. */
export function readPlan(raw: string, statement: string, analyzed: boolean): ExplainedPlan {
  if (!raw.includes("<ShowPlanXML")) {
    throw new PluginError(
      "statementFailed",
      "SQL Server returned no XML plan; run the statement with SET SHOWPLAN_XML ON to see why.",
    );
  }
  const document = parseXml(raw);
  const statements = descendants(document, "StmtSimple");
  const roots = statements.flatMap((element) => {
    const plan = descendants(element, "QueryPlan")[0];
    return plan === undefined ? [] : childRelops(plan).map(planNode);
  });
  const summary = statements.flatMap((element) => [
    ...SUMMARY_KEYS.flatMap((key) => {
      const value = element.attributes[key];
      return value === undefined ? [] : [{ name: key, value }];
    }),
    ...descendants(element, "QueryTimeStats").flatMap((stats) =>
      TIME_KEYS.flatMap(([key, label]) => {
        const value = stats.attributes[key];
        return value === undefined ? [] : [{ name: label, value: `${value} ms` }];
      }),
    ),
  ]);
  return { statement, analyzed, roots, summary, raw };
}
