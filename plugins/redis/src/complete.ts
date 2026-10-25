import type {
  CompletionItem,
  CompletionRequest,
  CompletionResult,
  Session,
  SignatureHelp,
} from "@table-craft/plugin-api";
import {
  argumentText,
  docKey,
  isContainer,
  SNAPSHOT_DOCS,
  syntaxOf,
  type CommandDoc,
  type CommandDocs,
  type DocArgument,
} from "./docs.js";
import { RedisSession } from "./session.js";
import { quoteArgument, tokenize, type Token } from "./tokens.js";

const COMMAND_WORD = "^[\\w|.-]*$";
const KEY_BOOST = 10;
const COMMENT = "#";

interface Line {
  /** Where the line starts in the request's text. */
  readonly start: number;
  /** The line up to the caret. */
  readonly text: string;
  /** Every complete argument before the one at the caret. */
  readonly before: readonly Token[];
  /** The argument the caret is in, or null right after a blank. */
  readonly current: Token | null;
}

function lineAt(request: CompletionRequest): Line {
  const start = request.text.lastIndexOf("\n", request.offset - 1) + 1;
  const text = request.text.slice(start, request.offset);
  const tokens = tokenize(text);
  const last = tokens.at(-1);
  const current = last !== undefined && last.to === text.length ? last : null;
  return { start, text, before: current === null ? tokens : tokens.slice(0, -1), current };
}

function empty(offset: number): CompletionResult {
  return { from: offset, to: offset, items: [], validFor: null };
}

async function docsOf(session: RedisSession | null): Promise<CommandDocs> {
  if (session === null) return SNAPSHOT_DOCS;
  return session.commandDocs().catch(() => SNAPSHOT_DOCS);
}

function commandInfo(name: string, doc: CommandDoc): string {
  return `${syntaxOf(name, doc)}\n\n${doc.summary}\nSince ${doc.since} · ${doc.group}`;
}

function commandItem(label: string, key: string, doc: CommandDoc): CompletionItem {
  return {
    label,
    kind: "function",
    detail: doc.group,
    apply: label,
    boost: 0,
    info: commandInfo(key, doc),
    caret: null,
  };
}

/** Every literal word the command's syntax holds, such as `NX`, `EX` or `MATCH`, with what it introduces. */
function keywordsOf(args: readonly DocArgument[], into = new Map<string, DocArgument>()): Map<string, DocArgument> {
  for (const argument of args) {
    if (argument.token !== undefined && !into.has(argument.token.toUpperCase()))
      into.set(argument.token.toUpperCase(), argument);
    if (argument.arguments !== undefined) keywordsOf(argument.arguments, into);
  }
  return into;
}

/** Top-level arguments filled by position, not introduced by a keyword. */
function positionalOf(doc: CommandDoc): DocArgument[] {
  return (doc.arguments ?? []).filter(
    (argument) =>
      argument.token === undefined &&
      argument.optional !== true &&
      argument.type !== "oneof" &&
      argument.type !== "block",
  );
}

interface Position {
  /** The positional argument the caret is at, or null. */
  readonly expected: DocArgument | null;
  /** How many positional arguments came before it. */
  readonly index: number;
  /** The word before the caret is a keyword that takes a value, so no keyword fits here. */
  readonly valueOf: DocArgument | null;
}

function positionIn(doc: CommandDoc, words: readonly string[]): Position {
  const keywords = keywordsOf(doc.arguments ?? []);
  const positional = positionalOf(doc);
  let index = 0;
  let valueOf: DocArgument | null = null;
  for (const word of words) {
    if (valueOf !== null) {
      valueOf = null;
      continue;
    }
    const keyword = keywords.get(word);
    if (keyword !== undefined) {
      valueOf = keyword.type === "pure-token" ? null : keyword;
      continue;
    }
    index += 1;
  }
  const last = positional.at(-1);
  const expected = positional[index] ?? (last?.multiple === true ? last : null);
  return { expected, index, valueOf };
}

function commandOf(line: Line, docs: CommandDocs): { key: string; doc: CommandDoc; words: string[] } | null {
  const words = line.before.map((token) => token.text.toUpperCase());
  const key = docKey(docs, words);
  if (key === null) return null;
  const doc = docs.get(key);
  if (doc === undefined) return null;
  return { key, doc, words: words.slice(key.split(" ").length) };
}

async function completeLine(request: CompletionRequest, session: RedisSession | null): Promise<CompletionResult> {
  const line = lineAt(request);
  if (line.text.trimStart().startsWith(COMMENT)) return empty(request.offset);
  if (line.current !== null && !line.current.closed) return empty(line.start + line.current.from);
  const from = line.start + (line.current?.from ?? line.text.length);
  const docs = await docsOf(session);
  if (line.before.length === 0) {
    const items = [...docs].filter(([key]) => !key.includes(" ")).map(([key, doc]) => commandItem(key, key, doc));
    return { from, to: request.offset, items, validFor: COMMAND_WORD };
  }
  const name = line.before[0]?.text.toUpperCase() ?? "";
  if (line.before.length === 1 && isContainer(docs, name)) {
    const items = [...docs]
      .filter(([key]) => key.startsWith(`${name} `))
      .map(([key, doc]) => commandItem(key.slice(name.length + 1), key, doc));
    return { from, to: request.offset, items, validFor: COMMAND_WORD };
  }
  const command = commandOf(line, docs);
  if (command === null) return { from, to: request.offset, items: [], validFor: null };
  const position = positionIn(command.doc, command.words);
  const items: CompletionItem[] = [];
  const wantsKey = (position.valueOf ?? position.expected)?.type === "key";
  if (wantsKey && session !== null) {
    const keys = await session.suggestKeys(line.current?.text ?? "").catch(() => []);
    for (const key of keys) {
      items.push({
        label: key.name,
        kind: "table",
        detail: key.type,
        apply: quoteArgument(key.name),
        boost: KEY_BOOST,
        info: null,
        caret: null,
      });
    }
  }
  if (position.valueOf === null) {
    const used = new Set(command.words);
    for (const [word, argument] of keywordsOf(command.doc.arguments ?? [])) {
      if (used.has(word) && argument.multiple !== true) continue;
      const detail = argument.type === "pure-token" ? null : argument.name;
      items.push({ label: word, kind: "keyword", detail, apply: word, boost: 0, info: null, caret: null });
    }
  }
  return { from, to: request.offset, items, validFor: null };
}

/** What fits at the caret: a command, a subcommand, a keyword of its syntax, or a key name. */
export async function complete(request: CompletionRequest, session: Session | null): Promise<CompletionResult> {
  try {
    return await completeLine(request, session instanceof RedisSession ? session : null);
  } catch {
    return empty(request.offset);
  }
}

/** The command the caret is in and which of its positional arguments the caret is at. */
export async function signatureAt(request: CompletionRequest, session: Session | null): Promise<SignatureHelp | null> {
  try {
    const line = lineAt(request);
    const first = line.before[0] ?? line.current;
    if (first === null || line.text.trimStart().startsWith(COMMENT)) return null;
    const docs = await docsOf(session instanceof RedisSession ? session : null);
    const command = commandOf(line, docs);
    if (command === null) return null;
    const end = request.text.indexOf("\n", request.offset);
    return {
      name: command.key,
      summary: command.doc.summary,
      signatures: [
        {
          parameters: (command.doc.arguments ?? []).map((argument) => ({
            name: argumentText(argument),
            ...(argument.optional === true ? { optional: true } : {}),
            ...(argument.multiple === true ? { variadic: true } : {}),
          })),
          returns: "",
        },
      ],
      argument: positionIn(command.doc, command.words).index,
      from: line.start + first.from,
      to: end === -1 ? request.text.length : end,
    };
  } catch {
    return null;
  }
}
