import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

/** Where the tokenizer is on a line. */
interface EtcdLineState {
  /** Before the command word: a section label, a compare or a command comes next. */
  commandSeen: boolean;
  /** After a command with subcommands (`lease grant`), before its subcommand. */
  subcommandNext: boolean;
  /** On a compare line (`mod("k") > 5`), where `(`, `)` and operators split words. */
  compare: boolean;
}

const COMMANDS = new Set(["get", "put", "del", "txn", "end", "compaction", "defrag"]);
/** Commands whose next word names what they do: `lease grant`, `member list`. */
const COMMAND_GROUPS = new Set(["lease", "member", "endpoint", "alarm", "user", "role", "auth"]);
const SECTION_LABEL = /^(?:if|then|else):/i;
const COMPARE = /^(?:value|mod|create|version|lease)(?=\()/i;
const FLAG = /^--?[A-Za-z][\w-]*/;
const OPERATOR = /^(?:!=|=|<|>)/;
const PUNCTUATION = /^[(),]/;
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?=[\s),]|$)/i;
const WORD = /^[^\s"']+/;
const COMPARE_WORD = /^[^\s"'()=<>!,]+/;
const NO_STATE: EtcdLineState = { commandSeen: false, subcommandNext: false, compare: false };

function quoted(stream: StringStream, quote: string): void {
  let escaped = false;
  for (let next = stream.next(); next !== undefined; next = stream.next()) {
    if (next === quote && !escaped) return;
    escaped = quote === '"' && next === "\\" && !escaped;
  }
}

function startLine(state: EtcdLineState): void {
  Object.assign(state, NO_STATE);
}

function commandToken(stream: StringStream, state: EtcdLineState): string | null {
  if (stream.match(SECTION_LABEL)) return "keyword";
  if (stream.match(COMPARE)) {
    state.commandSeen = true;
    state.compare = true;
    return "typeName";
  }
  const word = (stream.match(WORD) as RegExpMatchArray | null)?.[0].toLowerCase() ?? "";
  state.commandSeen = true;
  state.subcommandNext = COMMAND_GROUPS.has(word);
  return COMMANDS.has(word) || state.subcommandNext ? "keyword" : null;
}

/**
 * etcdctl-like lines (plan 110): `#` comments, the command and its subcommand, `--flag[=value]`,
 * `txn` section labels, compares such as `mod("k") > 5`, quoted strings and numbers.
 */
export const etcdParser: StreamParser<EtcdLineState> = {
  name: "etcd",
  startState: () => ({ ...NO_STATE }),
  copyState: (state) => ({ ...state }),
  blankLine: startLine,
  token(stream, state) {
    if (stream.sol()) startLine(state);
    if (stream.eatSpace()) return null;
    if (!state.commandSeen && stream.peek() === "#") {
      stream.skipToEnd();
      return "lineComment";
    }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      quoted(stream, quote);
      state.commandSeen = true;
      state.subcommandNext = false;
      return "string";
    }
    if (!state.commandSeen) return commandToken(stream, state);
    if (state.subcommandNext && !stream.match(FLAG, false)) {
      state.subcommandNext = false;
      stream.match(WORD);
      return "keyword";
    }
    if (stream.match(FLAG)) return "name.special";
    if (stream.match(NUMBER)) return "number";
    if (stream.match(OPERATOR)) return "operator";
    if (state.compare && stream.match(PUNCTUATION)) return "punctuation";
    stream.match(state.compare ? COMPARE_WORD : WORD);
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

export const etcdLanguage = StreamLanguage.define(etcdParser);
