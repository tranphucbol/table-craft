import type { ExecutedStatement } from "./sessions.js";
import type { WireValue } from "./wire.js";
import type { KeyLeaseAssignment } from "./keyAdvanced.js";

/** Mirrors `KEY_TYPES` in plugin-api (decision 113). */
export const KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream", "json", "other"] as const;
export type KeyType = (typeof KEY_TYPES)[number];

/** Mirrors `KeyBytes` in plugin-api: text with invalid bytes `\xNN`, and the hex when any is. */
export interface KeyBytes {
  readonly text: string;
  readonly hex: string | null;
}

export type KeyName = KeyBytes;

export interface KeyRevision {
  readonly createRevision: string;
  readonly modRevision: string;
  readonly version: string;
  readonly lease: string;
}

export interface KeyConflictSnapshot {
  readonly database: number;
  readonly key: KeyBytes;
  readonly value: KeyBytes | null;
  readonly revision: KeyRevision | null;
  readonly snapshotRevision: string;
}

export interface KeyspaceFeatures {
  readonly leaseAssignment?: boolean;
  readonly revisionGuard?: boolean;
}

export interface KeyHistoryRequest {
  readonly database: number;
  readonly key: KeyBytes;
  readonly cursor: string | null;
  readonly count: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export interface KeyHistoryEvent extends KeyRevision {
  readonly kind: "PUT" | "DELETE";
  readonly key: KeyBytes;
  readonly value: KeyBytes | null;
}

export interface KeyHistoryGap {
  readonly fromRevision: string;
  readonly toRevision: string;
  readonly reason: "compacted";
}

export type KeyHistoryStopReason = "snapshotEnd" | "pageLimit" | "byteLimit" | "deadline" | "compacted";

export interface KeyHistoryPage {
  readonly events: readonly KeyHistoryEvent[];
  readonly snapshotRevision: string;
  readonly terminalRevision: string | null;
  readonly cursor: string | null;
  readonly complete: boolean;
  readonly unavailableThrough: string | null;
  readonly gaps: readonly KeyHistoryGap[];
  readonly stopReason: KeyHistoryStopReason;
}

export const KEY_HISTORY_MAX_COUNT = 100;
export const KEY_HISTORY_MAX_BYTES = 1_048_576;
export const KEY_HISTORY_MAX_TIMEOUT_MS = 5_000;
export const KEY_HISTORY_MAX_CURSOR_LENGTH = 8_192;

/** Mirrors `KeySource` in plugin-api: the one key a command's reply read (decision 119). */
export interface KeySource {
  readonly database: number;
  readonly key: KeyName;
  readonly type: KeyType;
  readonly whole: boolean;
}

/** Mirrors `KeyDatabase` in plugin-api. */
export interface KeyDatabase {
  readonly index: number;
  readonly keys: number;
  readonly expires: number;
  readonly current: boolean;
}

/** The databases of a `keyValue` datasource and the delimiter its key tree folds names on. */
export interface KeyDatabases {
  readonly features?: KeyspaceFeatures & { readonly history?: boolean };
  readonly delimiter: string;
  readonly databases: readonly KeyDatabase[];
}

/** Mirrors `KeyScan` in plugin-api. */
export interface KeyScan {
  readonly keys: readonly KeyName[];
  readonly cursor: string | null;
  readonly scanned: number;
}

/** Mirrors `KeyInfo` in plugin-api. */
export interface KeyInfo {
  readonly key: KeyName;
  readonly type: KeyType | null;
  readonly typeName: string | null;
  readonly ttlMs: number | null;
}

/** Mirrors `KeyDetails` in plugin-api: each fact null when the server would not say. */
export interface KeyDetails extends KeyInfo {
  readonly revision?: KeyRevision;
  readonly length: number | null;
  readonly memoryBytes: number | null;
  readonly encoding: string | null;
  readonly idleSeconds: number | null;
  readonly attributes?: readonly KeyAttribute[];
}

/** Mirrors `KeyAttribute` in plugin-api. */
export interface KeyAttribute {
  readonly name: string;
  readonly value: string;
}

/** Which part of a key the key tab reads: a `MATCH` glob, a stream id range, a list offset. */
export interface KeyReadRange {
  readonly match?: string;
  readonly from?: string;
  readonly to?: string;
  readonly offset?: number;
}

/**
 * A key opened in its tab (decision 113): the details, then rows in the result store for the
 * collection types, or the value itself for a string; `readOnly` says why it cannot be edited.
 */
export interface OpenedKey {
  readonly details: KeyDetails;
  readonly statement: ExecutedStatement | null;
  readonly value: WireValue | null;
  readonly readOnly: string | null;
}

/** Mirrors `KeyChange` in plugin-api: one pending change, with what the element held when read. */
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

/** Mirrors `KeyApplyOptions` in plugin-api. */
export interface KeyApplyOptions {
  readonly lease?: KeyLeaseAssignment;
  readonly revisionGuard?: { readonly modRevision: string };
  readonly type: KeyType;
  readonly guard: boolean;
  readonly ttlMs?: number;
}

/** Mirrors `KeyApplied` in plugin-api. */
export interface KeyApplied {
  readonly commands: readonly string[];
}

/** Mirrors `KeyExpiry` in plugin-api. */
export type KeyExpiry = { readonly inMs: number } | { readonly at: string } | null;
