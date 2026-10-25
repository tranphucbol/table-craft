/**
 * RESP2 replies in their RESP3 shape (decision 116): a server before 6.0 speaks RESP2 only, which
 * sends maps as flat arrays and scores as bulk strings. Reshaping them here keeps one rendering, so
 * `HGETALL` shows `key` and `value` columns on 5.0 as on 7.4.
 */

type Argument = string | Buffer;

/** Replies that are a map in RESP3, by command (and subcommand). */
const MAP_REPLIES = new Set(["HGETALL", "CONFIG GET", "MEMORY STATS", "XINFO STREAM"]);
/** Replies that are a list of maps in RESP3. */
const MAP_LIST_REPLIES = new Set(["XINFO GROUPS", "XINFO CONSUMERS"]);
/** Commands whose `WITHSCORES` reply is a list of `[member, score]` pairs in RESP3. */
const SCORED_RANGES = new Set([
  "ZRANGE",
  "ZRANGEBYSCORE",
  "ZREVRANGE",
  "ZREVRANGEBYSCORE",
  "ZUNION",
  "ZINTER",
  "ZDIFF",
  "ZRANDMEMBER",
]);
/** Commands whose reply is one score, a double in RESP3. */
const SCORES = new Set(["ZSCORE", "ZINCRBY"]);
const POPS = new Set(["ZPOPMIN", "ZPOPMAX"]);
const BLOCKING_POPS = new Set(["BZPOPMIN", "BZPOPMAX"]);
const CONTAINERS = new Set(["CONFIG", "MEMORY", "XINFO"]);
/** `BZPOPMIN key… timeout` answers `[key, member, score]`. */
const BLOCKING_POP_SCORE = 2;
const POP_WITHOUT_COUNT = 2;

function word(argument: Argument | undefined): string {
  return argument === undefined ? "" : String(argument).toUpperCase();
}

/** A score as RESP3 sends it: a number, `inf` and `-inf` included. */
export function scoreOf(reply: unknown): unknown {
  if (!(reply instanceof Uint8Array) && typeof reply !== "string") return reply;
  const text = Buffer.from(reply).toString("utf8").toLowerCase();
  if (text === "inf" || text === "+inf") return Number.POSITIVE_INFINITY;
  if (text === "-inf") return Number.NEGATIVE_INFINITY;
  const score = Number(text);
  return Number.isNaN(score) ? reply : score;
}

function mapOf(reply: readonly unknown[]): Map<unknown, unknown> {
  const map = new Map<unknown, unknown>();
  for (let index = 0; index + 1 < reply.length; index += 2) map.set(reply[index], reply[index + 1]);
  return map;
}

function scoredPairs(reply: readonly unknown[]): unknown[][] {
  const pairs: unknown[][] = [];
  for (let index = 0; index + 1 < reply.length; index += 2) pairs.push([reply[index], scoreOf(reply[index + 1])]);
  return pairs;
}

function hasWord(args: readonly Argument[], wanted: string): boolean {
  return args.some((argument, index) => index > 0 && word(argument) === wanted);
}

/** `reply` to the command `args` reshaped as RESP3 would send it; anything else unchanged. */
export function asResp3(args: readonly Argument[], reply: unknown): unknown {
  const name = word(args[0]);
  const key = CONTAINERS.has(name) ? `${name} ${word(args[1])}` : name;
  if (!Array.isArray(reply)) return SCORES.has(key) ? scoreOf(reply) : reply;
  const elements = reply as readonly unknown[];
  if (MAP_REPLIES.has(key)) return mapOf(elements);
  if (MAP_LIST_REPLIES.has(key))
    return elements.map((element) => (Array.isArray(element) ? mapOf(element as unknown[]) : element));
  if (SCORED_RANGES.has(key) && hasWord(args, "WITHSCORES")) return scoredPairs(elements);
  if (key === "ZMSCORE") return elements.map(scoreOf);
  if (POPS.has(key)) {
    const [member, score] = elements;
    return args.length <= POP_WITHOUT_COUNT && elements.length === 2 ? [member, scoreOf(score)] : scoredPairs(elements);
  }
  if (BLOCKING_POPS.has(key) && elements.length > BLOCKING_POP_SCORE)
    return elements.map((element, index) => (index === BLOCKING_POP_SCORE ? scoreOf(element) : element));
  return reply;
}
