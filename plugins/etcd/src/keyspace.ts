import {
  ConflictError,
  PluginError,
  type KeyApplied,
  type KeyApplyOptions,
  type KeyAttribute,
  type KeyChange,
  type KeyContents,
  type KeyDatabase,
  type KeyDetails,
  type KeyExpiry,
  type KeyInfo,
  type KeyHistoryRequest,
  type KeyHistoryPage,
  type KeyName,
  type KeyReadRequest,
  type KeyScan,
  type KeyScanRequest,
  type Keyspace,
} from "@table-craft/plugin-api";
import type { IKeyValue, IRequestOp } from "etcd3";
import type { Call } from "./admin.js";
import { errorText, isPermissionDenied } from "./client.js";
import { bytesOf, keyBytesOf } from "./keyBytes.js";
import { HistoryState, keyHistory, revisionOf } from "./history.js";
import { bytesCell, leaseCell } from "./results.js";
import { decodeCursor, encodeCursor, globMatches, literalPrefix, NO_END, prefixEnd } from "./scan.js";
import { applyPlan, planText, type ApplyPlan } from "./writes.js";
import { EtcdKeyRanges } from "./keyRanges.js";
import type { RuntimeHost } from "./runtime.js";
import type {
  KeyChildrenRequest,
  KeyChildrenPage,
  KeyRange,
  KeyRangeCount,
  KeyDeletePreview,
  KeyDeleteResult,
} from "@table-craft/plugin-api";

const DATABASE = 0;
const MS_PER_SECOND = 1000;
const EXPIRED_TTL = 0;
const STRING_TYPE = "string";
/** etcd's default `--max-txn-ops` is 128. */
const MAX_TXN_OPS = 128;
const COMPACTED = /required revision has been compacted/i;
const NO_LEASE = "0";
const NONE = "none";
const MAX_CONFLICT_BYTES = 1024 * 1024;

/** What the keyspace needs from its session. */
export interface KeyspaceHost {
  readonly call: Call;
  readonly runtime?: RuntimeHost;
  readonly delimiter: string;
  readonly scanBatch: number;
  /** A read-only datasource's keyspace refuses every change. */
  readonly readOnly: boolean;
  /** Runs `work` after every earlier keyspace call, one at a time. */
  queued<T>(work: () => Promise<T>): Promise<T>;
}

function requireDatabase(database: number): void {
  if (database !== DATABASE) throw new PluginError("statementFailed", "etcd has one keyspace, database 0.");
}

/** The etcd keyspace (decisions 3–7 of plan 110): one database whose every key holds one string value. */
export class EtcdKeyspace implements Keyspace {
  readonly features = { revisionGuard: true, leaseAssignment: true };
  readonly delimiter: string;
  readonly #host: KeyspaceHost;
  readonly #history = new HistoryState();
  readonly #ranges: EtcdKeyRanges | undefined;

  constructor(host: KeyspaceHost) {
    this.#host = host;
    this.delimiter = host.delimiter;
    this.#ranges = host.runtime === undefined ? undefined : new EtcdKeyRanges(host.runtime, host.delimiter);
  }

  children(request: KeyChildrenRequest): Promise<KeyChildrenPage> {
    return this.#queued(() => this.#rangeService().children(request));
  }

  countRange(database: number, range: KeyRange): Promise<KeyRangeCount> {
    return this.#queued(() => this.#rangeService().countRange(database, range));
  }

  prepareDelete(database: number, range: KeyRange): Promise<KeyDeletePreview> {
    return this.#queued(() => this.#rangeService().prepareDelete(database, range));
  }

  deletePrepared(token: string): Promise<KeyDeleteResult> {
    return this.#queued(() => this.#rangeService().deletePrepared(token));
  }

  #rangeService(): EtcdKeyRanges {
    if (this.#ranges === undefined) throw new PluginError("statementFailed", "Reconnect to use guarded key ranges.");
    return this.#ranges;
  }

  databases(): Promise<readonly KeyDatabase[]> {
    return this.#queued(async () => {
      let keys = 0;
      try {
        const counted = await this.#host.call((etcd) =>
          etcd.kv.range({ key: NO_END, range_end: NO_END, count_only: true }),
        );
        keys = Number(counted.count);
      } catch (cause) {
        // A role that reads part of the keyspace may not count all of it; the tree still opens.
        if (!isPermissionDenied(cause)) throw cause;
      }
      return [{ index: DATABASE, keys, expires: 0, current: true }];
    });
  }

  history(request: KeyHistoryRequest): Promise<KeyHistoryPage> {
    return this.#queued(() => {
      requireDatabase(request.database);
      return keyHistory(this.#host.call, request, this.#history);
    });
  }

  close(): void {
    this.#history.close();
  }

  scan(request: KeyScanRequest): Promise<KeyScan> {
    return this.#queued(async () => {
      requireDatabase(request.database);
      if (request.type !== null && request.type !== STRING_TYPE) return { keys: [], cursor: null, scanned: 0 };
      const prefix = literalPrefix(request.match);
      const end = prefix.length === 0 ? NO_END : prefixEnd(prefix);
      const position = decodeCursor(request.cursor);
      // etcd refuses an empty key; `\0` is the first key there is.
      const from = position?.from ?? (prefix.length === 0 ? NO_END : prefix);
      const range = (revision: string) =>
        this.#host.call((etcd) =>
          etcd.kv.range({
            key: from,
            range_end: end,
            keys_only: true,
            limit: request.count ?? this.#host.scanBatch,
            revision,
          }),
        );
      let revision = position?.revision ?? "0";
      let response;
      try {
        try {
          response = await range(revision);
        } catch (cause) {
          // A pass outlived the history it pinned: it carries on at the head, never failing.
          if (!COMPACTED.test(errorText(cause))) throw cause;
          revision = "0";
          response = await range(revision);
        }
      } catch (cause) {
        if (!isPermissionDenied(cause)) throw cause;
        throw new PluginError(
          "statementFailed",
          `The datasource's user may not read every key ${JSON.stringify(request.match)} covers. Filter the keys by a prefix its role can read, such as /app/*.`,
          { cause },
        );
      }
      const pinned = revision === "0" ? response.header.revision : revision;
      const keys = response.kvs.filter((kv) => globMatches(request.match, kv.key)).map((kv) => keyBytesOf(kv.key));
      const last = response.kvs.at(-1);
      return {
        keys,
        cursor: response.more && last !== undefined ? encodeCursor(pinned, last.key) : null,
        scanned: response.kvs.length,
      };
    });
  }

  describe(database: number, keys: readonly KeyName[]): Promise<readonly KeyInfo[]> {
    return this.#queued(async () => {
      requireDatabase(database);
      return Promise.all(
        keys.map(async (key) => {
          const kv = await this.#get(bytesOf(key), true);
          return {
            key,
            type: kv === null ? null : STRING_TYPE,
            typeName: kv === null ? null : STRING_TYPE,
            ttlMs: kv === null ? null : await this.#ttlMs(kv.lease),
          };
        }),
      );
    });
  }

  read(database: number, key: KeyName, _request: KeyReadRequest): Promise<KeyContents> {
    return this.#queued(async () => {
      requireDatabase(database);
      const kv = await this.#get(bytesOf(key), false);
      if (kv === null) {
        const details: KeyDetails = {
          key,
          type: null,
          typeName: null,
          ttlMs: null,
          length: null,
          memoryBytes: null,
          encoding: null,
          idleSeconds: null,
        };
        return { details, result: null, value: null, readOnly: null };
      }
      const details: KeyDetails = {
        key,
        type: STRING_TYPE,
        typeName: STRING_TYPE,
        ttlMs: await this.#ttlMs(kv.lease),
        length: kv.value.length,
        memoryBytes: null,
        encoding: null,
        idleSeconds: null,
        attributes: attributesOf(kv),
        revision: revisionOf(kv),
      };
      return { details, result: null, value: bytesCell(kv.value, { fullBytes: true }), readOnly: null };
    });
  }

  preview(key: KeyName, changes: readonly KeyChange[], options: KeyApplyOptions): readonly string[] {
    return planText(applyPlan(key, changes, options, null));
  }

  apply(database: number, key: KeyName, changes: readonly KeyChange[], options: KeyApplyOptions): Promise<KeyApplied> {
    return this.#writing("put", database, async () => {
      // Validate before acquiring a lease: a rejected plan cannot own server resources.
      applyPlan(key, changes, options, null);
      const lease = options.ttlMs === undefined ? null : await this.#grant(options.ttlMs);
      const plan = applyPlan(key, changes, options, lease);
      const response = await this.#withOwnedLease(lease, () => this.#host.call((etcd) => etcd.kv.txn(plan.request)));
      if (plan.guarded && !response.succeeded) {
        if (lease !== null) await this.#revoke(lease);
        const currentRange = response.responses[0]?.response_range;
        const now = currentRange?.kvs[0];
        throw new ConflictError(key.text, now === undefined ? "it is gone" : nowText(now, plan), {
          ...(currentRange === undefined ||
          (now !== undefined && now.key.length + now.value.length > MAX_CONFLICT_BYTES)
            ? {}
            : {
                current: {
                  database,
                  key,
                  value: now === undefined ? null : keyBytesOf(now.value),
                  revision: now === undefined ? null : revisionOf(now),
                  snapshotRevision: response.header.revision,
                },
              }),
        });
      }
      return { commands: planText(plan) };
    });
  }

  rename(database: number, key: KeyName, to: KeyName, overwrite: boolean): Promise<void> {
    return this.#writing("txn", database, async () => {
      const from = bytesOf(key);
      const target = bytesOf(to);
      if (from.equals(target)) {
        throw new PluginError("statementFailed", `${key.text} already has that name. Enter a different new name.`);
      }
      const kv = await this.#get(from, false);
      if (kv === null) throw new PluginError("statementFailed", `${key.text} no longer exists.`);
      const response = await this.#host.call((etcd) =>
        etcd.kv.txn({
          compare: [
            { key: from, target: "Mod", result: "Equal", mod_revision: kv.mod_revision },
            ...(overwrite
              ? []
              : [{ key: target, target: "Create" as const, result: "Equal" as const, create_revision: 0 }]),
          ],
          success: [
            { request_put: { key: target, value: kv.value, lease: kv.lease } },
            { request_delete_range: { key: from } },
          ],
        }),
      );
      if (response.succeeded) return;
      if (!overwrite && (await this.#get(target, true)) !== null) {
        throw new PluginError("statementFailed", `${to.text} already exists. Tick Overwrite to replace it.`);
      }
      throw new PluginError("statementFailed", `${key.text} changed while it was renamed. Reload it and rename again.`);
    });
  }

  expire(database: number, key: KeyName, expiry: KeyExpiry): Promise<void> {
    return this.#writing("put", database, async () => {
      const name = bytesOf(key);
      const ms = expiry === null ? null : "inMs" in expiry ? expiry.inMs : Date.parse(expiry.at) - Date.now();
      if (ms !== null && ms <= 0) {
        // An expiry already past deletes the key now, as Redis does, rather than leasing it a second.
        const deleted = await this.#host.call((etcd) =>
          etcd.kv.txn({
            compare: [{ key: name, target: "Create", result: "Greater", create_revision: 0 }],
            success: [{ request_delete_range: { key: name } }],
          }),
        );
        if (!deleted.succeeded) throw new PluginError("statementFailed", `${key.text} no longer exists.`);
        return;
      }
      const lease = ms === null ? NO_LEASE : await this.#grant(ms);
      // Re-put with the new lease and the value as it is; the old lease is never revoked, since
      // other keys may hold it.
      const response = await this.#withOwnedLease(lease === NO_LEASE ? null : lease, () =>
        this.#host.call((etcd) =>
          etcd.kv.txn({
            compare: [{ key: name, target: "Create", result: "Greater", create_revision: 0 }],
            success: [{ request_put: { key: name, lease, ignore_value: true } }],
          }),
        ),
      );
      if (!response.succeeded) {
        if (lease !== NO_LEASE) await this.#revoke(lease);
        throw new PluginError("statementFailed", `${key.text} no longer exists.`);
      }
    });
  }

  remove(database: number, keys: readonly KeyName[]): Promise<number> {
    return this.#writing("del", database, async () => {
      // etcd refuses a Txn that names one key twice.
      const unique = [...new Map(keys.map((key) => [bytesOf(key).toString("hex"), bytesOf(key)])).values()];
      let removed = 0;
      for (let start = 0; start < unique.length; start += MAX_TXN_OPS) {
        const batch: IRequestOp[] = unique
          .slice(start, start + MAX_TXN_OPS)
          .map((key) => ({ request_delete_range: { key } }));
        const response = await this.#host.call((etcd) => etcd.kv.txn({ success: batch }));
        for (const entry of response.responses) removed += Number(entry.response_delete_range?.deleted ?? 0);
      }
      return removed;
    });
  }

  async #get(key: Buffer, keysOnly: boolean): Promise<IKeyValue | null> {
    const response = await this.#host.call((etcd) => etcd.kv.range({ key, keys_only: keysOnly }));
    return response.kvs[0] ?? null;
  }

  async #ttlMs(lease: string): Promise<number | null> {
    if (lease === NO_LEASE) return null;
    const live = await this.#host.call((etcd) => etcd.leaseClient.leaseTimeToLive({ ID: lease }));
    const seconds = Number(live.TTL);
    return seconds > EXPIRED_TTL ? seconds * MS_PER_SECOND : null;
  }

  async #grant(ms: number): Promise<string> {
    const seconds = Math.max(1, Math.ceil(ms / MS_PER_SECOND));
    return (await this.#host.call((etcd) => etcd.leaseClient.leaseGrant({ TTL: seconds }))).ID;
  }

  async #revoke(lease: string): Promise<void> {
    await this.#host.call((etcd) => etcd.leaseClient.leaseRevoke({ ID: lease })).catch(() => undefined);
  }

  async #withOwnedLease<T>(lease: string | null, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      // Transport errors may arrive after commit; revoking then would delete the saved key.
      if (
        lease !== null &&
        /permission denied|invalid argument|request is too large|too many operations|duplicate key/i.test(
          errorText(cause),
        )
      ) {
        await this.#revoke(lease);
      }
      throw cause;
    }
  }

  #writing<T>(command: string, database: number, work: () => Promise<T>): Promise<T> {
    if (this.#host.readOnly) {
      return Promise.reject(
        new PluginError(
          "statementFailed",
          `read-only datasource refuses ${command}, which writes. Turn off Read-only on the datasource to change keys.`,
        ),
      );
    }
    return this.#queued(async () => {
      requireDatabase(database);
      return work();
    });
  }

  #queued<T>(work: () => Promise<T>): Promise<T> {
    return this.#host.queued(work);
  }
}

/** The key's revisions and lease as the key tab lists them (decision 5 of plan 110). */
export function attributesOf(kv: IKeyValue): KeyAttribute[] {
  return [
    { name: "create_revision", value: kv.create_revision },
    { name: "mod_revision", value: kv.mod_revision },
    { name: "version", value: kv.version },
    { name: "lease", value: leaseCell(kv.lease) ?? NONE },
  ];
}

function nowText(now: IKeyValue, plan: ApplyPlan): string {
  if (plan.original === null) return "it exists now";
  const value = bytesCell(now.value);
  return `the value is now ${typeof value === "string" ? JSON.stringify(value) : `${String(now.value.length)} bytes`}`;
}
