/** What one agent session spent its model calls on, from the OpenCode session store's rows. */
import { isAbsolute, posix } from "node:path";

export type CallKind =
  "lookup" | "edit-code" | "edit-docs" | "verify" | "live-test" | "git" | "delegate" | "compress" | "other";

/** A step that ran no tool: the model only wrote text or reasoned. */
export const THINK_KIND = "think";
export type StepKind = CallKind | typeof THINK_KIND;

export interface MessageRow {
  type: string;
  data: string;
}

export interface ChildSession {
  agent: string | null;
  cost: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  /** The session's working directory, stripped from absolute paths so reads of one file count together. */
  directory: string;
  rows: MessageRow[];
  children: ChildSession[];
}

export interface Call {
  name: string;
  kind: CallKind;
  /** Repository-relative files the call read whole or in part. */
  files: string[];
  ranMs: number;
}

export interface Step {
  context: number;
  cost: number;
  calls: Call[];
}

export interface Spend {
  steps: number;
  cost: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  steps: number;
  contextFirst: number;
  contextAverage: number;
  contextMax: number;
  compactions: number;
  oneToolSteps: number;
  /** Steps whose every call only read or searched. */
  lookupSteps: number;
  /** Steps that edited or wrote at least one file. */
  editSteps: number;
  compressCalls: number;
  smokeRuns: number;
  smokeMinutes: number;
  /** Files read more than once, most-read first. */
  reReads: [file: string, reads: number][];
  maxReads: number;
  byKind: Map<StepKind, Spend>;
  beforeFirstCodeEdit: Spend;
  editing: Spend;
  afterLastCodeEdit: Spend;
  cost: number;
  subagents: Map<string, Spend>;
  exploreSubagents: number;
  subagentCost: number;
}

/** USD per token for Claude Opus, used only for a message the store saved without its cost. */
const RATES = { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 };
/** A context this much smaller than the step before means the conversation was compacted. */
const COMPACTION_RATIO = 0.6;
const MS_PER_MINUTE = 60_000;
const EXPLORE_AGENT = "explore";
const UNNAMED_AGENT = "?";

const LOOKUP_TOOLS = new Set(["read", "grep", "glob", "list"]);
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);
const DELEGATE_TOOLS = new Set(["subagent", "task"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);
const READ_PATH_KEYS = ["path", "filePath"] as const;

const LIVE_TEST_COMMAND = /test:smoke|headless|playwright|TABLE_CRAFT_EVIDENCE_DIR/;
const VERIFY_COMMAND = /bun run (test|lint|typecheck|format)|vitest|\btsc\b|eslint|prettier|docker compose/;
const GIT_COMMAND = /\bgit (commit|push|add|checkout|switch|rebase|merge|fetch|stash|reset|cherry-pick)\b|\bgh pr\b/;
const LOOKUP_COMMAND = /(^|[;&|(]\s*)(cat|sed|head|tail|nl|grep|rg|ls|find|wc|git (show|log|diff|blame|grep|status))\b/;
const COMMAND_SEPARATOR = /&&|\|\||[;|]/;
/** Shell programs whose file arguments count as reading that file. */
const FILE_READERS = new Set(["cat", "sed", "head", "tail", "nl"]);
const CHANGE_DIRECTORY = "cd";
const FILE_ARGUMENT = /^[\w./-]+\.[A-Za-z]\w*$/;
const QUOTES = /^['"]|['"]$/g;
const DOCS_PATH = /(^|\/)docs\/|\.md$/;

interface RawTool {
  type?: string;
  name?: string;
  state?: { input?: Record<string, unknown> | null };
  time?: { ran?: number; completed?: number };
}

interface RawAssistant {
  cost?: number;
  content?: RawTool[];
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read: number; write: number };
  };
}

export function classifyCall(name: string, input: Record<string, unknown>, directory = ""): Call {
  const call: Call = { name, kind: "other", files: [], ranMs: 0 };
  if (LOOKUP_TOOLS.has(name)) {
    call.kind = "lookup";
    if (name === "read") call.files = readPaths(input, directory);
  } else if (EDIT_TOOLS.has(name)) {
    call.kind = readPaths(input, directory).some((path) => DOCS_PATH.test(path)) ? "edit-docs" : "edit-code";
  } else if (DELEGATE_TOOLS.has(name)) {
    call.kind = "delegate";
  } else if (name === "compress") {
    call.kind = "compress";
  } else if (SHELL_TOOLS.has(name)) {
    const command = typeof input.command === "string" ? input.command : "";
    call.kind = classifyCommand(command);
    if (call.kind === "lookup") call.files = filesReadBy(command, directory);
  }
  return call;
}

function classifyCommand(command: string): CallKind {
  if (LIVE_TEST_COMMAND.test(command)) return "live-test";
  if (VERIFY_COMMAND.test(command)) return "verify";
  if (GIT_COMMAND.test(command)) return "git";
  if (LOOKUP_COMMAND.test(command)) return "lookup";
  return "other";
}

function readPaths(input: Record<string, unknown>, directory: string): string[] {
  return READ_PATH_KEYS.flatMap((key) => {
    const value = input[key];
    return typeof value === "string" ? [relativeTo(directory, value)] : [];
  });
}

function filesReadBy(command: string, directory: string): string[] {
  let cwd = "";
  return command.split(COMMAND_SEPARATOR).flatMap((segment) => {
    const [program, ...args] = segment
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(QUOTES, ""));
    if (program === CHANGE_DIRECTORY && args[0] !== undefined) cwd = relativeTo(directory, args[0]);
    if (program === undefined || !FILE_READERS.has(program)) return [];
    return args
      .filter((arg) => !arg.startsWith("-") && FILE_ARGUMENT.test(arg))
      .map((arg) => (isAbsolute(arg) ? relativeTo(directory, arg) : posix.join(cwd, arg)));
  });
}

function relativeTo(directory: string, path: string): string {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  if (`${path}/` === prefix) return "";
  const relative = directory !== "" && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return relative.replace(/^\.\//, "");
}

/** The model call a stored assistant message records, or undefined for one that never reached the model. */
export function parseStep(data: string, directory = ""): Step | undefined {
  const message = JSON.parse(data) as RawAssistant;
  const tokens = message.tokens;
  if (tokens?.cache === undefined) return undefined;
  const input = tokens.input ?? 0;
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  const cost =
    typeof message.cost === "number"
      ? message.cost
      : input * RATES.input +
        output * RATES.output +
        tokens.cache.read * RATES.cacheRead +
        tokens.cache.write * RATES.cacheWrite;
  const calls = (message.content ?? [])
    .filter((part) => part.type === "tool" && typeof part.name === "string")
    .map((part) => {
      const call = classifyCall(part.name ?? "", part.state?.input ?? {}, directory);
      const { ran, completed } = part.time ?? {};
      if (ran !== undefined && completed !== undefined) call.ranMs = completed - ran;
      return call;
    });
  return { context: input + tokens.cache.read + tokens.cache.write, cost, calls };
}

export function summarise(session: SessionRecord): SessionSummary {
  const steps = session.rows
    .filter((row) => row.type === "assistant")
    .flatMap((row) => parseStep(row.data, session.directory) ?? []);
  const contexts = steps.map((step) => step.context);
  const reads = new Map<string, number>();
  const byKind = new Map<StepKind, Spend>();
  let compressCalls = 0;
  let smokeRuns = 0;
  let smokeMs = 0;
  for (const step of steps) {
    const kinds = new Set<StepKind>(step.calls.length === 0 ? [THINK_KIND] : step.calls.map((call) => call.kind));
    for (const kind of kinds) addSpend(byKind, kind, 1, step.cost / kinds.size);
    for (const call of step.calls) {
      for (const file of call.files) reads.set(file, (reads.get(file) ?? 0) + 1);
      if (call.kind === "compress") compressCalls += 1;
      if (call.kind === "live-test") {
        smokeRuns += 1;
        smokeMs += call.ranMs;
      }
    }
  }
  const editsCode = steps.map((step) => step.calls.some((call) => call.kind === "edit-code"));
  const firstEdit = editsCode.indexOf(true);
  const lastEdit = editsCode.lastIndexOf(true);
  const segment = (from: number, to: number): Spend => ({ steps: to - from, cost: sumCost(steps.slice(from, to)) });
  const subagents = new Map<string, Spend>();
  for (const child of session.children) addSpend(subagents, child.agent ?? UNNAMED_AGENT, 1, child.cost);
  const reReads = [...reads].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    id: session.id,
    title: session.title,
    steps: steps.length,
    contextFirst: contexts[0] ?? 0,
    contextAverage: contexts.length === 0 ? 0 : Math.round(sum(contexts) / contexts.length),
    contextMax: Math.max(0, ...contexts),
    compactions: contexts.filter((context, i) => i > 0 && context < (contexts[i - 1] ?? 0) * COMPACTION_RATIO).length,
    oneToolSteps: steps.filter((step) => step.calls.length === 1).length,
    lookupSteps: steps.filter((step) => step.calls.length > 0 && step.calls.every((call) => call.kind === "lookup"))
      .length,
    editSteps: steps.filter((step) => step.calls.some((call) => call.kind === "edit-code" || call.kind === "edit-docs"))
      .length,
    compressCalls,
    smokeRuns,
    smokeMinutes: Math.round(smokeMs / MS_PER_MINUTE),
    reReads,
    maxReads: Math.max(0, ...reads.values()),
    byKind,
    beforeFirstCodeEdit: firstEdit < 0 ? segment(0, steps.length) : segment(0, firstEdit),
    editing: firstEdit < 0 ? segment(0, 0) : segment(firstEdit, lastEdit + 1),
    afterLastCodeEdit: firstEdit < 0 ? segment(0, 0) : segment(lastEdit + 1, steps.length),
    cost: sumCost(steps),
    subagents,
    exploreSubagents: subagents.get(EXPLORE_AGENT)?.steps ?? 0,
    subagentCost: sum(session.children.map((child) => child.cost)),
  };
}

function addSpend<K>(spend: Map<K, Spend>, key: K, steps: number, cost: number): void {
  const current = spend.get(key) ?? { steps: 0, cost: 0 };
  spend.set(key, { steps: current.steps + steps, cost: current.cost + cost });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumCost(steps: Step[]): number {
  return sum(steps.map((step) => step.cost));
}

const TOP_RE_READS = 8;
const THOUSAND = 1000;
const TABLE_COLUMNS = [
  "Session",
  "Steps",
  "Avg ctx",
  "Max ctx",
  "1-tool",
  "Lookup",
  "Edit",
  "Max reads",
  "Explore",
  "Cost",
  "+Sub",
] as const;
const TITLE_WIDTH = 34;

export function formatReport(summaries: SessionSummary[]): string {
  const rows = summaries.map((s) => [
    s.title.slice(0, TITLE_WIDTH),
    String(s.steps),
    kilo(s.contextAverage),
    kilo(s.contextMax),
    percent(s.oneToolSteps, s.steps),
    String(s.lookupSteps),
    String(s.editSteps),
    String(s.maxReads),
    String(s.exploreSubagents),
    dollars(s.cost),
    dollars(s.subagentCost),
  ]);
  if (summaries.length > 1) {
    const median = (pick: (s: SessionSummary) => number) => medianOf(summaries.map(pick));
    rows.push([
      "median",
      String(median((s) => s.steps)),
      kilo(median((s) => s.contextAverage)),
      kilo(median((s) => s.contextMax)),
      percent(
        median((s) => s.oneToolSteps / s.steps),
        1,
      ),
      String(median((s) => s.lookupSteps)),
      String(median((s) => s.editSteps)),
      String(median((s) => s.maxReads)),
      String(median((s) => s.exploreSubagents)),
      dollars(median((s) => s.cost)),
      dollars(median((s) => s.subagentCost)),
    ]);
  }
  return [table([...TABLE_COLUMNS], rows), ...summaries.map(formatDetail)].join("\n\n") + "\n";
}

function formatDetail(s: SessionSummary): string {
  const kinds = [...s.byKind]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([kind, spend]) => `${kind} ${spend.steps} steps ${dollars(spend.cost)} (${percent(spend.cost, s.cost)})`);
  const phase = (label: string, spend: Spend) =>
    `  ${label.padEnd(22)} ${String(spend.steps).padStart(4)} steps ${dollars(spend.cost).padStart(7)} (${percent(spend.cost, s.cost)})`;
  const subagents = [...s.subagents].map(([agent, spend]) => `${agent} ×${spend.steps} ${dollars(spend.cost)}`);
  return [
    `=== ${s.title} (${s.id})`,
    `  context first ${kilo(s.contextFirst)}, average ${kilo(s.contextAverage)}, max ${kilo(s.contextMax)}; ` +
      `${s.compactions} compactions, ${s.compressCalls} compress calls`,
    `  smoke runs ${s.smokeRuns}, ${s.smokeMinutes} min`,
    `  cost by step kind: ${kinds.join(", ")}`,
    phase("before first code edit", s.beforeFirstCodeEdit),
    phase("first..last code edit", s.editing),
    phase("after last code edit", s.afterLastCodeEdit),
    `  subagents: ${subagents.length === 0 ? "none" : subagents.join(", ")}`,
    `  re-read files: ${
      s.reReads.length === 0
        ? "none"
        : s.reReads
            .slice(0, TOP_RE_READS)
            .map(([file, count]) => `${file} ×${count}`)
            .join(", ")
    }`,
  ].join("\n");
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function kilo(tokens: number): string {
  return `${Math.round(tokens / THOUSAND)}K`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
