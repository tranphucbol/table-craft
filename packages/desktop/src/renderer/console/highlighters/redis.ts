import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

/** Where the tokenizer is on a line: before the command word, or among its arguments. */
interface RedisLineState {
  commandSeen: boolean;
}

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?=\s|$)/i;
const WORD = /^[^\s"']+/;

function quoted(stream: StringStream, quote: string): void {
  let escaped = false;
  for (let next = stream.next(); next !== undefined; next = stream.next()) {
    if (next === quote && !escaped) return;
    escaped = quote === '"' && next === "\\" && !escaped;
  }
}

/** `redis-cli` lines (decision 112): `#` comments, the command word, quoted strings and numbers. */
export const redisParser: StreamParser<RedisLineState> = {
  name: "redis",
  startState: () => ({ commandSeen: false }),
  copyState: (state) => ({ ...state }),
  blankLine: (state) => {
    state.commandSeen = false;
  },
  token(stream, state) {
    if (stream.sol()) state.commandSeen = false;
    if (stream.eatSpace()) return null;
    if (!state.commandSeen && stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      quoted(stream, quote);
      state.commandSeen = true;
      return "string";
    }
    if (!state.commandSeen) {
      stream.match(WORD);
      state.commandSeen = true;
      return "keyword";
    }
    if (stream.match(NUMBER)) return "number";
    stream.match(WORD);
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

export const redisLanguage = StreamLanguage.define(redisParser);
