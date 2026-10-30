/**
 * Drives the real OpenCode CLI for the agent GIF: `opencode run --format json` in a scratch folder
 * whose `opencode.json` is the configuration TableCraft copied, so the recording shows a real model
 * calling the app's MCP server. Needs `opencode` on the PATH and a model it is signed in to.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

/** Asynchronous, so the screencast keeps taking frames while OpenCode answers. */
const runCommand = promisify(execFile);
/** The last message of a session's export once its turn ended. */
const SESSION_IDLE = "idle";

const OPENCODE = "opencode";
/** `README_OPENCODE_MODEL` picks another, as `provider/model`. */
const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";
const OPENCODE_MISSING = "Install OpenCode (https://opencode.ai) and sign in to a model to record the agent GIF.";
const SCRATCH_PREFIX = "table-craft-readme-opencode-";
/**
 * `--auto` approves the agent's own tools, so without this it may reach the database around
 * TableCraft, with `docker compose exec psql`, as a first run did.
 */
const DENY_SHELL = { action: "shell", resource: "*", effect: "deny" };
/** Every event as OpenCode printed it, for a recording that went wrong. */
export const EVENT_LOG = join(tmpdir(), "table-craft-readme-opencode.jsonl");

export type AgentEvent =
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly input: Record<string, unknown>;
      readonly output: string;
      readonly failed: boolean;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function opencodeModel(): string {
  return process.env.README_OPENCODE_MODEL ?? DEFAULT_MODEL;
}

export function requireOpencode(): void {
  const probe = spawnSync(OPENCODE, ["--version"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) throw new Error(OPENCODE_MISSING);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const CODE_MODE_TOOL = "execute";
const MCP_CALL = /tools\.(\w+)\.(\w+)\(/g;
const STRING_ARGUMENT = (key: string) => new RegExp(`${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
const SHOWN_ARGUMENTS = ["sql", "table", "schema", "datasource"] as const;
const NAMES_SHOWN = 4;

/**
 * A call as one line: `server.tool` and its telling argument. OpenCode in code mode wraps MCP calls
 * in `execute`, a script calling `tools.<server>.<tool>(...)`; the line names the last of them.
 */
export function callLine(tool: string, input: Record<string, unknown>): string {
  if (tool !== CODE_MODE_TOOL) {
    const key = SHOWN_ARGUMENTS.find((name) => typeof input[name] === "string");
    return key === undefined ? tool : `${tool} ${String(input[key])}`;
  }
  const code = text(input.code);
  const calls = [...code.matchAll(MCP_CALL)];
  if (calls.length === 0) return tool;
  return calls
    .map((call, index) => {
      const own = code.slice(call.index, calls[index + 1]?.index);
      const argument = SHOWN_ARGUMENTS.map((key) => STRING_ARGUMENT(key).exec(own)?.[1]).find(
        (value) => value !== undefined,
      );
      return `${call[1]}.${call[2]}${argument === undefined ? "" : ` ${argument}`}`;
    })
    .join(" · ")
    .replace(/\s+/g, " ");
}

function names(items: unknown, key: string): string {
  if (!Array.isArray(items)) return "";
  const all = items.map((item) => text(record(item)[key])).filter((name) => name.length > 0);
  const more = all.length > NAMES_SHOWN ? `, +${String(all.length - NAMES_SHOWN)}` : "";
  return all.slice(0, NAMES_SHOWN).join(", ") + more;
}

/** What a call answered, in a few words: rows changed or read, the objects listed, else its first line. */
export function resultLine(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output.split("\n").find((line) => line.trim().length > 0) ?? "";
  }
  return summary(record(parsed)) ?? output.replace(/\s+/g, " ");
}

function summary(answer: Record<string, unknown>): string | null {
  if (typeof answer.rowsAffected === "number") return `${String(answer.rowsAffected)} rows affected`;
  if (Array.isArray(answer.rows)) return `${String(answer.rows.length)} rows`;
  if (Array.isArray(answer.datasources)) return names(answer.datasources, "name");
  if (Array.isArray(answer.tables)) return names(answer.tables, "name");
  if (Array.isArray(answer.schemas)) return names(answer.schemas, "schema");
  if (Array.isArray(answer.items)) return names(answer.items, "path");
  const table = record(answer.table);
  if (Array.isArray(table.columns)) return `${String(table.columns.length)} columns: ${names(table.columns, "name")}`;
  // Code mode returns what the script built, often an object holding several answers.
  const parts = Object.values(answer).map((value) => summary(record(value)));
  return parts.length > 0 && parts.every((part) => part !== null) ? parts.join(" · ") : null;
}

/** A reply's opening paragraph without Markdown code marks; its tables do not fit a line. */
function firstParagraph(reply: string): string {
  return (reply.trim().split(/\n\s*\n/)[0] ?? "").replaceAll("`", "").replace(/\s+/g, " ");
}

/** One `--format json` line as what the transcript shows, or null for the steps it skips. */
export function agentEvent(line: string): AgentEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = record(parsed);
  const part = record(event.part);
  if (event.type === "error") return { kind: "error", message: text(record(event.error).message) };
  if (event.type === "text" && text(part.text).trim().length > 0)
    return { kind: "text", text: firstParagraph(text(part.text)) };
  if (event.type !== "tool_use") return null;
  const state = record(part.state);
  return {
    kind: "tool",
    tool: text(part.tool),
    input: record(state.input),
    output: text(state.output) || text(state.error),
    failed: state.status === "error",
  };
}

export interface AgentRun {
  /** Settles once OpenCode exits, with its exit code. */
  readonly exited: Promise<number>;
  readonly running: () => boolean;
  readonly stop: () => void;
}

export class OpencodeFolder {
  readonly directory = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));

  /**
   * `copied` is the configuration Settings copied; the model is pinned and the shell denied on top
   * of it, the model for the TUI, which takes no `-m`.
   */
  constructor(copied: string) {
    const config = { ...record(JSON.parse(copied)), model: opencodeModel(), permissions: [DENY_SHELL] };
    writeFileSync(join(this.directory, "opencode.json"), JSON.stringify(config, null, 2));
    writeFileSync(EVENT_LOG, "");
  }

  /** OpenCode takes its project folder from PWD, which a spawn inherits from this process. */
  private inFolder() {
    return { cwd: this.directory, env: { ...process.env, PWD: this.directory } };
  }

  run(prompt: string, onEvent: (event: AgentEvent) => void): AgentRun {
    const child = spawn(
      OPENCODE,
      ["run", "--standalone", "--format", "json", "--auto", "-m", opencodeModel(), prompt],
      {
        ...this.inFolder(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let alive = true;
    createInterface({ input: child.stdout }).on("line", (line) => {
      appendFileSync(EVENT_LOG, `${line}\n`);
      const event = agentEvent(line);
      if (event !== null) onEvent(event);
    });
    child.stderr.on("data", (chunk: Buffer) => appendFileSync(EVENT_LOG, `# ${chunk.toString()}`));
    const exited = new Promise<number>((settle) => {
      child.on("exit", (code) => {
        alive = false;
        settle(code ?? 1);
      });
    });
    return { exited, running: () => alive, stop: () => child.kill() };
  }

  /** The sessions OpenCode keeps for this folder, newest first. */
  async sessions(): Promise<string[]> {
    const { stdout } = await runCommand(OPENCODE, ["session", "list", "--format", "json"], this.inFolder());
    const folders = new Set([this.directory, realpathSync(this.directory)]);
    const listed: unknown = JSON.parse(stdout);
    return (Array.isArray(listed) ? listed : [])
      .map(record)
      .filter((session) => folders.has(text(session.directory)))
      .sort((a, b) => Number(b.updated) - Number(a.updated))
      .map((session) => text(session.id));
  }

  /** True once the folder's newest session ended its turn, as the TUI's run has no exit to wait for. */
  async finished(): Promise<boolean> {
    const [newest] = await this.sessions();
    if (newest === undefined) return false;
    const { stdout } = await runCommand(OPENCODE, ["session", "export", newest], this.inFolder());
    const messages = record(JSON.parse(stdout)).messages;
    return Array.isArray(messages) && record(messages.at(-1)).type === SESSION_IDLE;
  }

  async dispose(): Promise<void> {
    const sessions = await this.sessions().catch(() => []);
    await Promise.all(
      sessions.map((id) => runCommand(OPENCODE, ["session", "delete", id], this.inFolder()).catch(() => undefined)),
    );
    rmSync(this.directory, { recursive: true, force: true });
  }
}
