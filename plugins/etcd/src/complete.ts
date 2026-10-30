import type {
  CompletionItem,
  CompletionRequest,
  CompletionResult,
  Session,
  SignatureHelp,
} from "@table-craft/plugin-api";
import { isFlag } from "./args.js";
import { COMMANDS, commandOf, isContainer, syntaxOf, type CommandDoc, type ParameterDoc } from "./docs.js";
import { split } from "./language.js";
import { END, TXN } from "./txn.js";
import { quoteArgument, tokenize, type Token } from "./tokens.js";

const COMMAND_WORD = "^[\\w-]*$";
const FLAG_WORD = "^[\\w=-]*$";
const KEY_BOOST = 10;
const FLAG_BOOST = -1;
const COMMENT = "#";
const BRANCH_HEADINGS = ["if:", "then:", "else:"];
const HEADING = /^\s*(?:if:|then:|else:)/i;
const TXN_OPS = new Set(["get", "put", "del", "txn"]);

/** What a session offers completion: keys starting with a prefix. */
export interface KeySuggester {
  suggestKeys(prefix: string): Promise<readonly string[]>;
  suggestConsoleValues?(
    kind: NonNullable<ParameterDoc["completion"]>,
    prefix: string,
  ): Promise<readonly { readonly label: string; readonly apply: string; readonly detail?: string }[]>;
}

function suggesterOf(session: Session | null): KeySuggester | null {
  if (session === null || !("suggestKeys" in session)) return null;
  return typeof session.suggestKeys === "function" ? (session as unknown as KeySuggester) : null;
}

interface Line {
  /** Where the line's command starts in the request's text, past a `then:` heading. */
  readonly start: number;
  /** The command up to the caret. */
  readonly text: string;
  readonly before: readonly Token[];
  /** The argument the caret is in, or null right after a blank. */
  readonly current: Token | null;
  /** The caret is inside a `txn` block, past its first line. */
  readonly inTxn: boolean;
}

function inTxnBlock(request: CompletionRequest, lineStart: number): boolean {
  const span = split(request.text).find((candidate) => candidate.from < lineStart && candidate.to >= lineStart - 1);
  return span !== undefined && span.sql.split(/\r?\n/)[0]?.trim().toLowerCase() === TXN;
}

function lineAt(request: CompletionRequest): Line {
  const lineStart = request.text.lastIndexOf("\n", request.offset - 1) + 1;
  const raw = request.text.slice(lineStart, request.offset);
  const heading = HEADING.exec(raw);
  const start = lineStart + (heading?.[0].length ?? 0);
  const text = request.text.slice(start, request.offset);
  const tokens = tokenize(text);
  const last = tokens.at(-1);
  const current = last !== undefined && last.to === text.length ? last : null;
  return {
    start,
    text,
    before: current === null ? tokens : tokens.slice(0, -1),
    current,
    inTxn: inTxnBlock(request, lineStart),
  };
}

function empty(offset: number): CompletionResult {
  return { from: offset, to: offset, items: [], validFor: null };
}

function commandItem(label: string, doc: CommandDoc | null, detail: string): CompletionItem {
  return {
    label,
    kind: "function",
    detail,
    apply: label,
    boost: 0,
    info: doc === null ? null : `${syntaxOf(doc)}\n\n${doc.summary}`,
    caret: null,
  };
}

function quotedCompareKey(name: string): string {
  const argument = quoteArgument(name);
  return argument.startsWith('"') ? argument : `"${argument}"`;
}

function firstWords(inTxn: boolean): CompletionItem[] {
  if (inTxn) {
    return [
      ...COMMANDS.filter((doc) => TXN_OPS.has(doc.name)).map((doc) => commandItem(doc.name, doc, doc.group)),
      ...[...BRANCH_HEADINGS, END].map((word) => ({ ...commandItem(word, null, TXN), kind: "keyword" as const })),
    ];
  }
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const doc of COMMANDS) {
    const first = doc.name.split(" ")[0] ?? doc.name;
    if (seen.has(first)) continue;
    seen.add(first);
    items.push(commandItem(first, first === doc.name ? doc : null, doc.group));
  }
  return items;
}

/** The positional argument the caret is at, skipping flags and the values of valued flags given apart. */
function parameterAt(doc: CommandDoc, args: readonly Token[]): { index: number; expected: ParameterDoc | null } {
  let index = 0;
  for (let at = 0; at < args.length; at += 1) {
    const token = args[at];
    if (token === undefined) continue;
    if (!isFlag(token)) {
      index += 1;
      continue;
    }
    const flag = doc.flags.find((candidate) => `--${candidate.name}` === token.text);
    if (flag?.value !== undefined) at += 1;
  }
  return { index, expected: doc.parameters[index] ?? null };
}

function flagItems(doc: CommandDoc, used: readonly Token[]): CompletionItem[] {
  const given = new Set(used.filter(isFlag).map((token) => token.text.split("=")[0]));
  return doc.flags
    .filter((flag) => !given.has(`--${flag.name}`))
    .map((flag) => {
      const label = `--${flag.name}`;
      const apply = flag.value === undefined ? label : `${label}=`;
      return {
        label,
        kind: "keyword",
        detail: flag.value ?? null,
        apply,
        boost: FLAG_BOOST,
        info: flag.summary,
        caret: null,
      };
    });
}

async function completeLine(request: CompletionRequest, suggester: KeySuggester | null): Promise<CompletionResult> {
  const line = lineAt(request);
  if (line.text.trimStart().startsWith(COMMENT)) return empty(request.offset);
  const from = line.start + (line.current?.from ?? line.text.length);
  if (line.inTxn && /^\s*(?:value|mod|create|version|lease)\(/i.test(line.text)) {
    const key = /^\s*(?:value|mod|create|version|lease)\(["']?([^"')]*$)/i.exec(line.text);
    if (key !== null && suggester !== null) {
      const prefix = key[1] ?? "";
      const keys = await suggester.suggestKeys(prefix).catch(() => []);
      const opening = line.text.indexOf("(") + 1;
      return {
        from: line.start + opening,
        to: request.offset,
        items: keys.map((name) => ({
          ...commandItem(name, null, "key"),
          kind: "table",
          apply: quotedCompareKey(name),
        })),
        validFor: null,
      };
    }
    return {
      from,
      to: request.offset,
      items: ["=", "!=", "<", ">"].map((op) => commandItem(op, null, "compare operator")),
      validFor: null,
    };
  }
  if (line.before.length === 0)
    return {
      from,
      to: request.offset,
      items: [
        ...firstWords(line.inTxn),
        ...(line.inTxn
          ? ["value", "version", "create", "mod", "lease"].map((target) => ({
              ...commandItem(target, null, "compare target"),
              apply: `${target}("`,
              caret: null,
            }))
          : []),
      ],
      validFor: COMMAND_WORD,
    };
  const name = line.before[0]?.text.toLowerCase() ?? "";
  if (line.before.length === 1 && isContainer(name)) {
    const items = COMMANDS.filter((doc) => doc.name.startsWith(`${name} `)).map((doc) =>
      commandItem(doc.name.slice(name.length + 1), doc, doc.group),
    );
    return { from, to: request.offset, items, validFor: COMMAND_WORD };
  }
  const found = commandOf(line.before.map((token) => token.text));
  if (found === null) return { from, to: request.offset, items: [], validFor: null };
  const { doc } = found;
  const args = line.before.slice(found.length);
  const current = line.current;
  const last = args.at(-1);
  const valueFlag = current?.text.startsWith("--lease=")
    ? "lease"
    : current?.text.startsWith("--rev=")
      ? "revision"
      : last?.text === "--lease"
        ? "lease"
        : last?.text === "--rev"
          ? "revision"
          : null;
  const valueKind = valueFlag ?? parameterAt(doc, args).expected?.completion;
  if (valueKind !== undefined && valueKind !== null && suggester?.suggestConsoleValues !== undefined) {
    const equals = current?.text.indexOf("=") ?? -1;
    const prefix = equals >= 0 ? (current?.text.slice(equals + 1) ?? "") : (current?.text ?? "");
    const values = await suggester.suggestConsoleValues(valueKind, prefix).catch(() => []);
    return {
      from: equals >= 0 ? from + equals + 1 : from,
      to: request.offset,
      items: values.map((value) => ({
        ...commandItem(value.label, null, value.detail ?? valueKind),
        apply: quoteArgument(value.apply),
      })),
      validFor: null,
    };
  }
  if (current !== null && isFlag(current)) {
    const equals = current.text.indexOf("=");
    const flag = doc.flags.find((candidate) => `--${candidate.name}` === current.text.slice(0, equals));
    if (equals >= 0 && flag?.choices !== undefined) {
      const items = flag.choices.map((choice) => ({
        ...commandItem(choice, null, flag.name),
        kind: "keyword" as const,
      }));
      return { from: from + equals + 1, to: request.offset, items, validFor: COMMAND_WORD };
    }
    return { from, to: request.offset, items: flagItems(doc, args), validFor: FLAG_WORD };
  }
  const items: CompletionItem[] = [];
  if (parameterAt(doc, args).expected?.key === true && suggester !== null) {
    const keys = await suggester.suggestKeys(current?.text ?? "").catch(() => []);
    for (const key of keys) {
      items.push({
        label: key,
        kind: "table",
        detail: null,
        apply: quoteArgument(key),
        boost: KEY_BOOST,
        info: null,
        caret: null,
      });
    }
  }
  if (current === null) items.push(...flagItems(doc, args));
  return { from, to: request.offset, items, validFor: null };
}

/** What fits at the caret: a command, a subcommand, a flag or its value, or a key name. */
export async function complete(request: CompletionRequest, session: Session | null): Promise<CompletionResult> {
  try {
    return await completeLine(request, suggesterOf(session));
  } catch {
    return empty(request.offset);
  }
}

/** The command the caret is in and which of its positional arguments the caret is at. */
export function signatureAt(request: CompletionRequest, _session: Session | null): Promise<SignatureHelp | null> {
  try {
    const line = lineAt(request);
    const first = line.before[0] ?? line.current;
    if (first === null || line.text.trimStart().startsWith(COMMENT)) return Promise.resolve(null);
    const found = commandOf(line.before.map((token) => token.text));
    if (found === null) return Promise.resolve(null);
    const { doc } = found;
    const end = request.text.indexOf("\n", request.offset);
    return Promise.resolve({
      name: doc.name,
      summary: doc.summary,
      signatures: [
        {
          parameters: [
            ...doc.parameters.map((parameter) => ({
              name: parameter.name,
              ...(parameter.optional === true ? { optional: true } : {}),
            })),
            ...doc.flags.map((flag) => ({
              name: `--${flag.name}${flag.value === undefined ? "" : `=<${flag.value}>`}`,
              optional: true,
            })),
          ],
          returns: "",
        },
      ],
      argument: parameterAt(doc, line.before.slice(found.length)).index,
      from: line.start + first.from,
      to: end === -1 ? request.text.length : end,
    });
  } catch {
    return Promise.resolve(null);
  }
}
