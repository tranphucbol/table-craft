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
  readonly completion?: "lease" | "user" | "role" | "revision" | "member" | "endpoint";
}

/** One console command, keyed by its words: `get`, `lease grant` (decision 8 of plan 110). */
export interface CommandDoc {
  readonly name: string;
  readonly summary: string;
  readonly group: string;
  readonly kind: StatementKind;
  readonly parameters: readonly ParameterDoc[];
  readonly flags: readonly FlagDoc[];
  readonly action?: "watch" | "keepAlive" | "snapshot" | "credentials" | "access" | "cluster" | "leaseRevoke";
}

const KEY: ParameterDoc = { name: "key", key: true };
const RANGE_END: ParameterDoc = { name: "range_end", optional: true, key: true };
const LEASE_ID: ParameterDoc = { name: "lease_id", completion: "lease" };
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
    parameters: [{ name: "revision", completion: "revision" }],
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
    name: "lease ttl",
    summary: "Shows a lease's remaining TTL (global lease).",
    group: "lease",
    kind: "read",
    parameters: [LEASE_ID],
    flags: [{ name: "keys", summary: "show namespace-relative attached keys" }],
  },
  {
    name: "lease keep-alive",
    summary: "Opens managed renewal; stopping renewal never revokes a lease.",
    group: "lease",
    kind: "write",
    parameters: [LEASE_ID],
    flags: [{ name: "once", summary: "renew once" }],
    action: "keepAlive",
  },
  {
    name: "watch",
    summary: "Opens the Watch tool window; never blocks a console request.",
    group: "kv",
    kind: "read",
    parameters: [KEY, RANGE_END],
    flags: [PREFIX, FROM_KEY, { name: "rev", value: "revision", summary: "start revision (decimal)" }],
    action: "watch",
  },
  {
    name: "snapshot save",
    summary: "Save a sensitive full-cluster snapshot through an authorized file dialog.",
    group: "cluster",
    kind: "read",
    parameters: [],
    flags: [],
    action: "snapshot",
  },
  ...["promote", "remove"].map((verb): CommandDoc => ({
    name: `member ${verb}`,
    summary: `${verb} a global cluster member after confirmation.`,
    group: "cluster",
    kind: "write",
    parameters: [{ name: "member_id", completion: "member" }],
    flags: [],
    action: "cluster",
  })),
  ...["add", "delete", "passwd"].map((verb): CommandDoc => ({
    name: `user ${verb}`,
    summary:
      verb === "delete"
        ? "Delete a global user after confirmation."
        : "Open the secure credential dialog; console passwords are never accepted.",
    group: "auth",
    kind: "write",
    parameters: [{ name: "user", completion: "user" }],
    flags: [],
    action: verb === "delete" ? "access" : "credentials",
  })),
  ...["grant-role", "revoke-role"].map((verb): CommandDoc => ({
    name: `user ${verb}`,
    summary: `${verb} for a global user.`,
    group: "auth",
    kind: "write",
    parameters: [
      { name: "user", completion: "user" },
      { name: "role", completion: "role" },
    ],
    flags: [],
    action: "access",
  })),
  ...["add", "delete"].map((verb): CommandDoc => ({
    name: `role ${verb}`,
    summary: `${verb} a global role.`,
    group: "auth",
    kind: "write",
    parameters: [{ name: "role", completion: "role" }],
    flags: [],
    action: "access",
  })),
  {
    name: "role grant-permission",
    summary: "Grant a cluster-global key-range permission to a global role (not namespace-relative).",
    group: "auth",
    kind: "write",
    parameters: [{ name: "role", completion: "role" }, { name: "permission" }, KEY, RANGE_END],
    flags: [PREFIX, FROM_KEY],
    action: "access",
  },
  {
    name: "role revoke-permission",
    summary: "Revoke a cluster-global key-range permission from a global role (not namespace-relative).",
    group: "auth",
    kind: "write",
    parameters: [{ name: "role", completion: "role" }, KEY, RANGE_END],
    flags: [PREFIX, FROM_KEY],
    action: "access",
  },
  ...["enable", "disable"].map((verb): CommandDoc => ({
    name: `auth ${verb}`,
    summary: `${verb} global authentication with self-lockout safeguards.`,
    group: "auth",
    kind: "write",
    parameters: [],
    flags: [],
    action: "access",
  })),
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
  {
    name: "user get",
    summary: "Shows a user's roles.",
    group: "auth",
    kind: "read",
    parameters: [{ ...NAME, completion: "user" }],
    flags: [],
  },
  { name: "role list", summary: "Lists the roles.", group: "auth", kind: "read", parameters: [], flags: [] },
  {
    name: "role get",
    summary: "Shows a role's permissions.",
    group: "auth",
    kind: "read",
    parameters: [{ ...NAME, completion: "role" }],
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

const LIVE_FEED = "requires a managed resource; use the corresponding tool window";
const NOT_YET = "is not in the console yet; use etcdctl for it";

/** Commands the console refuses, keyed by their words, with why (decision 8 of plan 110). */
const REFUSED: Readonly<Record<string, string>> = {
  lock: LIVE_FEED,
  elect: LIVE_FEED,
  "make-mirror": NOT_YET,
  "move-leader": NOT_YET,
  "member add": NOT_YET,
  "member update": NOT_YET,
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
