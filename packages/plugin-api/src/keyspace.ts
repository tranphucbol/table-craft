import type { ExecuteResult } from "./plugin.js";
import type { WireValue } from "./values.js";
import type {
  KeyChildrenPage,
  KeyChildrenRequest,
  KeyDeletePreview,
  KeyDeleteResult,
  KeyLeaseAssignment,
  KeyRange,
  KeyRangeCount,
} from "./keyAdvanced.js";

/** The key types the key tree tells apart (decision 113); a module type such as RedisJSON is `other`. */
export const KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream", "json", "other"] as const;

export type KeyType = (typeof KEY_TYPES)[number];

/**
 * Bytes that are usually text, such as a key name, a hash field or a value (decision 113). `text`
 * is the UTF-8 reading with each invalid byte written `\xNN`, as `redis-cli` prints it; `hex` is
 * every byte in lower-case hex when the bytes are not valid UTF-8, and null when they are. Sent
 * back to the plugin, `hex` wins when present.
 */
export interface KeyBytes {
  readonly text: string;
  readonly hex: string | null;
}

/** Revision identifiers stay decimal strings, never lossy JavaScript numbers. */
export interface KeyRevision {
  readonly createRevision: string;
  readonly modRevision: string;
  readonly version: string;
  readonly lease: string;
}

/** A complete current read after a refused write, never the historical value being restored. */
export interface KeyConflictSnapshot {
  readonly database: number;
  readonly key: KeyBytes;
  /** Null only when absent; empty bytes remain a present value. Never a truncated preview. */
  readonly value: KeyBytes | null;
  readonly revision: KeyRevision | null;
  readonly snapshotRevision: string;
}

/** Optional operations a keyspace implements; absent fields mean unsupported. */
export interface KeyspaceFeatures {
  readonly leaseAssignment?: boolean;
  /** `apply` atomically enforces `revisionGuard`, even when `guard` is false. */
  readonly revisionGuard?: boolean;
}

/** A bounded exact-key history window; null cursor starts a new pinned snapshot. */
export interface KeyHistoryRequest {
  readonly database: number;
  readonly key: KeyBytes;
  readonly cursor: string | null;
  /** Maximum events, 1–100. A cursor binds the exact binary key, database and snapshot. */
  readonly count: number;
  /** Maximum total decoded key/value bytes in this page, 1–1,048,576; never truncate an event. */
  readonly maxBytes: number;
  /** Work budget, 1–5,000 ms; stop with a continuation instead of opening a live watch. */
  readonly timeoutMs: number;
}

/** An event in chronological revision order; deletion is null, an empty PUT is empty bytes. */
export interface KeyHistoryEvent extends KeyRevision {
  readonly kind: "PUT" | "DELETE";
  readonly key: KeyBytes;
  readonly value: KeyBytes | null;
}

/** An inclusive revision interval whose events cannot be recovered. */
export interface KeyHistoryGap {
  readonly fromRevision: string;
  readonly toRevision: string;
  readonly reason: "compacted";
}

export type KeyHistoryStopReason = "snapshotEnd" | "pageLimit" | "byteLimit" | "deadline" | "compacted";

/** Bounded history pinned at R, with the key's current modification M (null if absent at R). */
export interface KeyHistoryPage {
  readonly events: readonly KeyHistoryEvent[];
  readonly snapshotRevision: string;
  readonly terminalRevision: string | null;
  /** Null when no further events can be retrieved; non-null for a resumable budget stop. */
  readonly cursor: string | null;
  /** True only when the entire history through R is known, without gaps. */
  readonly complete: boolean;
  /** Inclusive compaction boundary, not a fabricated creation or deletion event. */
  readonly unavailableThrough: string | null;
  readonly gaps: readonly KeyHistoryGap[];
  readonly stopReason: KeyHistoryStopReason;
}

/** A key's name: bytes, since a key may be any binary string. */
export type KeyName = KeyBytes;

/**
 * The one key a command's reply was read from (decision 119), so the host can open the key or
 * edit the reply as the key. `whole` is true when the reply holds the entire key, such as
 * `HGETALL` or `LRANGE k 0 -1`; its columns are then the ones `Keyspace.read` gives that type,
 * without positions a key tab adds (a zset's `#`), and a string's is one `value` column.
 */
export interface KeySource {
  readonly database: number;
  readonly key: KeyName;
  readonly type: KeyType;
  readonly whole: boolean;
}

/** One logical database of the keyspace: Redis' `db0`–`db15`, or the one database of a cluster. */
export interface KeyDatabase {
  readonly index: number;
  readonly keys: number;
  /** Keys with a time to live. */
  readonly expires: number;
  /** The database the connection is configured with. */
  readonly current: boolean;
}

export interface KeyScanRequest {
  readonly database: number;
  /** Null starts a pass; otherwise what the last `KeyScan.cursor` said, opaque to the host. */
  readonly cursor: string | null;
  /** A glob, as `SCAN … MATCH` takes it; `*` for every key. */
  readonly match: string;
  readonly type: KeyType | null;
  /**
   * The batch the server is asked to look at per round trip, not a promise of how many keys come
   * back; absent, the datasource's own setting.
   */
  readonly count?: number;
}

export interface KeyScan {
  readonly keys: readonly KeyName[];
  /** Null when the pass reached the end. */
  readonly cursor: string | null;
  /** Keys the server looked at, matching or not, so the host can say how far the pass got. */
  readonly scanned: number;
}

export interface KeyInfo {
  readonly key: KeyName;
  /** Null when the key does not exist (any more). */
  readonly type: KeyType | null;
  /** The server's name for the type, such as `ReJSON-RL` for `other` and `json`. */
  readonly typeName: string | null;
  /** Milliseconds left to live; null without an expiry. */
  readonly ttlMs: number | null;
}

/** What the key tab's header shows; each field null when the server or its ACL would not say. */
export interface KeyDetails extends KeyInfo {
  /** CURRENT read baseline for pending edits; never copy a historical event's revision on Restore. */
  readonly revision?: KeyRevision;
  /** Fields, elements, members, entries or bytes, by type. */
  readonly length: number | null;
  readonly memoryBytes: number | null;
  readonly encoding: string | null;
  readonly idleSeconds: number | null;
  /** Extra per-key facts a store reports, such as etcd's revisions and lease, the host lists as-is. */
  readonly attributes?: readonly KeyAttribute[];
}

/** One extra fact about a key, by the store's own name for it. */
export interface KeyAttribute {
  readonly name: string;
  readonly value: string;
}

/** Which part of a key `Keyspace.read` returns (decision 113). */
export interface KeyReadRequest {
  /** A glob over hash fields and set or sorted-set members. */
  readonly match?: string;
  /** The first stream id, `-` by default; the last is `to`, `+` by default. */
  readonly from?: string;
  readonly to?: string;
  /** The first list or sorted-set index read. */
  readonly offset?: number;
  /** At most this many elements. */
  readonly window: number;
}

/**
 * A key's contents: the elements as a result the host opens in its grid, or, for a string or a
 * type it does not read element by element, one value.
 */
export interface KeyContents {
  readonly details: KeyDetails;
  /** Rows of the elements: hash `field`, `value`; list `#`, `value`; and so on. Null for a string. */
  readonly result: ExecuteResult | null;
  /** The value of a string or of a JSON document, every byte up to the plugin's limit. */
  readonly value: WireValue | null;
  /** Why the contents cannot be edited, such as a value read only in part; null when they can. */
  readonly readOnly: string | null;
}

/**
 * One pending change to one key. `original` is what the element held when it was read, which a
 * guarded apply checks first (decision 115); null for an element that did not exist.
 */
export type KeyChange =
  | { readonly kind: "setString"; readonly value: KeyBytes; readonly original: KeyBytes | null }
  | {
      readonly kind: "setField";
      readonly field: KeyBytes;
      readonly value: KeyBytes;
      readonly original: KeyBytes | null;
    }
  | { readonly kind: "deleteField"; readonly field: KeyBytes; readonly original: KeyBytes }
  | { readonly kind: "setIndex"; readonly index: number; readonly value: KeyBytes; readonly original: KeyBytes }
  | { readonly kind: "deleteIndex"; readonly index: number; readonly original: KeyBytes }
  | { readonly kind: "push"; readonly value: KeyBytes }
  | { readonly kind: "addMember"; readonly member: KeyBytes }
  | { readonly kind: "deleteMember"; readonly member: KeyBytes }
  | {
      readonly kind: "setScore";
      readonly member: KeyBytes;
      readonly score: number;
      readonly original: number | null;
    }
  | { readonly kind: "addEntry"; readonly fields: readonly (readonly [KeyBytes, KeyBytes])[] }
  | { readonly kind: "deleteEntry"; readonly id: string };

export interface KeyApplyOptions {
  /** Absent preserves the current lease; detach never revokes it. */
  readonly lease?: KeyLeaseAssignment;
  /** Compare the CURRENT read's mod revision atomically, including "0" for an absent key. */
  readonly revisionGuard?: { readonly modRevision: string };
  /** The key's type as read, or the type of the key the changes create. */
  readonly type: KeyType;
  /** Check every change's `original` first and refuse with `conflict` when one differs. */
  readonly guard: boolean;
  /** Milliseconds to live to set with the changes, for a new key; absent leaves the expiry alone. */
  readonly ttlMs?: number;
}

export interface KeyApplied {
  /** The commands that ran, as `preview` lists them. */
  readonly commands: readonly string[];
}

/** A new expiry: milliseconds from now, an instant, or none at all. */
export type KeyExpiry = { readonly inMs: number } | { readonly at: string } | null;

/**
 * The keys of a key-value store, read and changed by the plugin (decision 113). Present on a
 * session exactly when the plugin declares `keyValue`. Calls queue on the session they hang off.
 */
export interface Keyspace {
  children?(request: KeyChildrenRequest): Promise<KeyChildrenPage>;
  countRange?(database: number, range: KeyRange): Promise<KeyRangeCount>;
  prepareDelete?(database: number, range: KeyRange): Promise<KeyDeletePreview>;
  deletePrepared?(token: string): Promise<KeyDeleteResult>;
  readonly features?: KeyspaceFeatures;
  /** Finite history only, not a live watch. Events are chronological within and across pages. */
  history?(request: KeyHistoryRequest): Promise<KeyHistoryPage>;
  /** What separates the levels of a key name, such as `:`, for the tree's folders. */
  readonly delimiter: string;
  databases(): Promise<readonly KeyDatabase[]>;
  /** One batch of a pass over the keys; nothing ever runs `KEYS`. */
  scan(request: KeyScanRequest): Promise<KeyScan>;
  /** Type and expiry of each key, in order. */
  describe(database: number, keys: readonly KeyName[]): Promise<readonly KeyInfo[]>;
  /** A key that does not exist reads with a null `details.type` and no contents. */
  read(database: number, key: KeyName, request: KeyReadRequest): Promise<KeyContents>;
  /** The commands `apply` would run for `changes`, numbered by the host. Pure. */
  preview(key: KeyName, changes: readonly KeyChange[], options: KeyApplyOptions): readonly string[];
  /**
   * Runs `changes` as one `MULTI`. Guarded, it first checks every `original` and rejects with
   * `conflict`, writing nothing, when one differs.
   */
  apply(database: number, key: KeyName, changes: readonly KeyChange[], options: KeyApplyOptions): Promise<KeyApplied>;
  /** Rejects with `statementFailed` when `to` exists and `overwrite` is false, or the key is gone. */
  rename(database: number, key: KeyName, to: KeyName, overwrite: boolean): Promise<void>;
  expire(database: number, key: KeyName, expiry: KeyExpiry): Promise<void>;
  /** Removes the keys that exist and says how many did. */
  remove(database: number, keys: readonly KeyName[]): Promise<number>;
}
