/** Mirrors `KEY_TYPES` in plugin-api (decision 113). */
export const KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream", "json", "other"] as const;
export type KeyType = (typeof KEY_TYPES)[number];

/** Mirrors `KeyBytes` in plugin-api: text with invalid bytes `\xNN`, and the hex when any is. */
export interface KeyBytes {
  readonly text: string;
  readonly hex: string | null;
}

export type KeyName = KeyBytes;

/** Mirrors `KeyDatabase` in plugin-api. */
export interface KeyDatabase {
  readonly index: number;
  readonly keys: number;
  readonly expires: number;
  readonly current: boolean;
}

/** The databases of a `keyValue` datasource and the delimiter its key tree folds names on. */
export interface KeyDatabases {
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

/** Mirrors `KeyExpiry` in plugin-api. */
export type KeyExpiry = { readonly inMs: number } | { readonly at: string } | null;
