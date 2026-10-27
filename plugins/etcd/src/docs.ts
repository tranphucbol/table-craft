import type { StatementKind } from "@table-craft/plugin-api";

/** A `--flag` of a command; `value` names what it takes after `=`, absent for a switch. */
export interface FlagDoc {
  readonly name: string;
  readonly value?: string;
  readonly summary: string;
  /** The values it accepts, offered by completion. */
  readonly choices?: readonly string[];
}

/** A positional argument; `key` when it names a key, so completion offers keys. */
export interface ParameterDoc {
  readonly name: string;
  readonly optional?: true;
  readonly key?: true;
}

/** One console command, keyed by its words: `get`, `lease grant` (decision 8 of plan 110). */
export interface CommandDoc {
  readonly name: string;
  readonly summary: string;
  readonly group: string;
  readonly kind: StatementKind;
  readonly parameters: readonly ParameterDoc[];
  readonly flags: readonly FlagDoc[];
}

const KEY: ParameterDoc = { name: "key", key: true };
const RANGE_END: ParameterDoc = { name: "range_end", optional: true, key: true };
const LEASE_ID: ParameterDoc = { name: "lease_id" };
const NAME: ParameterDoc = { name: "name" };

const PREFIX: FlagDoc = { name: "prefix", summary: "every key starting with key" };
const FROM_KEY: FlagDoc = { name: "from-key", summary: "every key from key on, in byte order" };
const PREV_KV: FlagDoc = { name: "prev-kv", summary: "return the key-value pair before the change" };

/** Every command the console runs, in the order completion offers them. */
export const COMMANDS: readonly CommandDoc[] = [
  {
    name: "get",
    summary: "Reads a key or a range of keys.",
    group: "kv",
    kind: "read",
    parameters: [KEY, RANGE_END],
    flags: [
      PREFIX,
      FROM_KEY,
      { name: "keys-only", summary: "return keys without values" },
      { name: "count-only", summary: "return only how many keys match" },
      { name: "print-value-only", summary: "return only the first value, as one reply" },
      { name: "limit", value: "N", summary: "at most N keys" },
      { name: "rev", value: "N", summary: "read at revision N" },
      {
        name: "sort-by",
        value: "target",
        summary: "sort by a target",
        choices: ["KEY", "CREATE", "MODIFY", "VALUE", "VERSION"],
      },
      { name: "order", value: "order", summary: "sort order", choices: ["ASCEND", "DESCEND"] },
    ],
  },
  {
    name: "put",
    summary: "Writes a key's value.",
    group: "kv",
    kind: "write",
    parameters: [KEY, { name: "value" }],
    flags: [
      { name: "lease", value: "hex id", summary: "attach the key to a lease" },
      PREV_KV,
      { name: "ignore-lease", summary: "keep the key's current lease" },
      { name: "ignore-value", summary: "keep the key's current value" },
    ],
  },
  {
    name: "del",
    summary: "Deletes a key or a range of keys.",
    group: "kv",
    kind: "write",
    parameters: [KEY, RANGE_END],
    flags: [PREFIX, FROM_KEY, PREV_KV],
  },
  {
    name: "txn",
    summary: "Runs compares, then one of two lists of get/put/del, atomically; close with end.",
    group: "kv",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "compaction",
    summary: "Discards the history before a revision.",
    group: "kv",
    kind: "write",
    parameters: [{ name: "revision" }],
    flags: [{ name: "physical", summary: "wait until the compaction is applied to the backend" }],
  },
  {
    name: "lease grant",
    summary: "Creates a lease with a time to live in seconds.",
    group: "lease",
    kind: "write",
    parameters: [{ name: "ttl" }],
    flags: [],
  },
  {
    name: "lease revoke",
    summary: "Revokes a lease and deletes its keys.",
    group: "lease",
    kind: "write",
    parameters: [LEASE_ID],
    flags: [],
  },
  {
    name: "lease timetolive",
    summary: "Shows a lease's time to live.",
    group: "lease",
    kind: "read",
    parameters: [LEASE_ID],
    flags: [{ name: "keys", summary: "list the keys attached to the lease" }],
  },
  { name: "lease list", summary: "Lists the active leases.", group: "lease", kind: "read", parameters: [], flags: [] },
  {
    name: "member list",
    summary: "Lists the cluster's members.",
    group: "cluster",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "endpoint status",
    summary: "Shows the connected endpoint's status.",
    group: "cluster",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "endpoint health",
    summary: "Checks the connected endpoint answers.",
    group: "cluster",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "endpoint hashkv",
    summary: "Shows the hash of the endpoint's key-value store.",
    group: "cluster",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "alarm list",
    summary: "Lists the active alarms.",
    group: "cluster",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "alarm disarm",
    summary: "Disarms every active alarm.",
    group: "cluster",
    kind: "write",
    parameters: [],
    flags: [],
  },
  {
    name: "defrag",
    summary: "Defragments the connected endpoint's storage.",
    group: "cluster",
    kind: "write",
    parameters: [],
    flags: [],
  },
  { name: "user list", summary: "Lists the users.", group: "auth", kind: "read", parameters: [], flags: [] },
  { name: "user get", summary: "Shows a user's roles.", group: "auth", kind: "read", parameters: [NAME], flags: [] },
  { name: "role list", summary: "Lists the roles.", group: "auth", kind: "read", parameters: [], flags: [] },
  {
    name: "role get",
    summary: "Shows a role's permissions.",
    group: "auth",
    kind: "read",
    parameters: [NAME],
    flags: [],
  },
  {
    name: "auth status",
    summary: "Shows whether authentication is on.",
    group: "auth",
    kind: "read",
    parameters: [],
    flags: [],
  },
];

const LIVE_FEED = "opens a live feed, which the console cannot show yet; use etcdctl for it";
const NOT_YET = "is not in the console yet; use etcdctl for it";

/** Commands the console refuses, keyed by their words, with why (decision 8 of plan 110). */
const REFUSED: Readonly<Record<string, string>> = {
  watch: LIVE_FEED,
  "lease keep-alive": LIVE_FEED,
  lock: LIVE_FEED,
  elect: LIVE_FEED,
  snapshot: NOT_YET,
  "make-mirror": NOT_YET,
  "move-leader": NOT_YET,
  "member add": NOT_YET,
  "member remove": NOT_YET,
  "member promote": NOT_YET,
  "member update": NOT_YET,
  "user add": NOT_YET,
  "user delete": NOT_YET,
  "user grant-role": NOT_YET,
  "user revoke-role": NOT_YET,
  "user passwd": NOT_YET,
  "role add": NOT_YET,
  "role delete": NOT_YET,
  "role grant-permission": NOT_YET,
  "role revoke-permission": NOT_YET,
  "auth enable": NOT_YET,
  "auth disable": NOT_YET,
};

const BY_NAME: ReadonlyMap<string, CommandDoc> = new Map(COMMANDS.map((doc) => [doc.name, doc]));

/** Whether `name` takes a subcommand, such as `lease`. */
export function isContainer(name: string): boolean {
  const prefix = `${name.toLowerCase()} `;
  return COMMANDS.some((doc) => doc.name.startsWith(prefix));
}

/** The command `words` name and how many words its name takes; null for one the console does not know. */
export function commandOf(words: readonly string[]): { doc: CommandDoc; length: number } | null {
  const [first = "", second = ""] = words.map((word) => word.toLowerCase());
  const pair = BY_NAME.get(`${first} ${second}`);
  if (pair !== undefined) return { doc: pair, length: 2 };
  const single = BY_NAME.get(first);
  return single === undefined ? null : { doc: single, length: 1 };
}

/** Why the console refuses `words`, or null when it does not. */
export function refusalOf(words: readonly string[]): string | null {
  const [first = "", second = ""] = words.map((word) => word.toLowerCase());
  const pair = `${first} ${second}`;
  const reason = REFUSED[pair];
  if (reason !== undefined) return `${pair} ${reason}.`;
  const single = REFUSED[first];
  return single === undefined ? null : `${first} ${single}.`;
}

/** The command's syntax line, such as `get <key> [<range_end>] [--prefix] …`. */
export function syntaxOf(doc: CommandDoc): string {
  const parameters = doc.parameters.map((parameter) =>
    parameter.optional === true ? `[<${parameter.name}>]` : `<${parameter.name}>`,
  );
  const flags = doc.flags.map((flag) => `[--${flag.name}${flag.value === undefined ? "" : `=<${flag.value}>`}]`);
  return [doc.name, ...parameters, ...flags].join(" ");
}
