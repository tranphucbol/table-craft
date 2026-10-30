import type {
  KeyRecord,
  KeyTransfer,
  KeyTransferEntry,
  KeyTransferExportPage,
  KeyTransferExportRequest,
  KeyTransferImported,
  KeyTransferInspection,
  KeyTransferPolicy,
} from "@table-craft/plugin-api";
import type { ICompare, IRequestOp } from "etcd3";
import { bytesOf, keyBytesOf } from "./keyBytes.js";
import { revisionOf } from "./history.js";
import {
  budget,
  database,
  decimal,
  guardFailed,
  invalid,
  logicalRange,
  MAX_BYTES,
  MAX_OPS,
  MAX_PAGE,
  writable,
  type RuntimeHost,
} from "./runtime.js";

interface Position {
  binding: string;
  revision: string;
  next: string;
}
export class EtcdTransfer implements KeyTransfer {
  constructor(readonly host: RuntimeHost) {}
  async exportPage(request: KeyTransferExportRequest): Promise<KeyTransferExportPage> {
    database(request.database);
    budget(request.count, MAX_PAGE, "count");
    budget(request.maxBytes, MAX_BYTES, "maxBytes");
    this.host.state.check();
    const binding = JSON.stringify({
      kind: "export",
      cluster: this.host.clusterId,
      namespace: this.host.namespace.prefix.toString("hex"),
      range: request.range,
    });
    const position = request.cursor === null ? null : this.host.state.read<Position>(request.cursor, binding);
    const range = logicalRange(request.range);
    const result = await this.host.call((etcd) =>
      etcd.kv.range({
        ...range,
        ...(position === null ? {} : { key: Buffer.from(position.next, "hex"), revision: position.revision }),
        limit: request.count,
      }),
    );
    const revision = position?.revision ?? result.header.revision;
    const records: KeyRecord[] = [];
    let bytes = 0;
    for (const kv of result.kvs) {
      const size = kv.key.length + kv.value.length;
      if (size > request.maxBytes && records.length === 0)
        invalid("A complete key/value exceeds the export page byte budget. Increase maxBytes.");
      if (bytes + size > request.maxBytes) break;
      bytes += size;
      records.push({ key: keyBytesOf(kv.key), value: keyBytesOf(kv.value), revision: revisionOf(kv) });
    }
    const last = records.at(-1);
    return {
      clusterId: this.host.clusterId,
      namespace: keyBytesOf(this.host.namespace.prefix),
      revision,
      records,
      cursor:
        last !== undefined && (result.more || records.length < result.kvs.length)
          ? this.host.state.cursor({
              binding,
              revision,
              next: Buffer.concat([bytesOf(last.key), Buffer.from([0])]).toString("hex"),
            } satisfies Position)
          : null,
    };
  }
  #validate(entries: readonly KeyTransferEntry[]): void {
    budget(entries.length, MAX_OPS, "entries");
    let bytes = 0;
    const keys = new Set<string>();
    for (const entry of entries) {
      const key = bytesOf(entry.key);
      const identity = key.toString("hex");
      if (keys.has(identity)) invalid("An import chunk cannot contain duplicate keys.");
      keys.add(identity);
      bytes += key.length + bytesOf(entry.value).length;
      if (entry.expectedModRevision !== null) decimal(entry.expectedModRevision);
    }
    if (bytes > MAX_BYTES) invalid("Import chunk exceeds 1 MiB. Split it into smaller chunks.");
  }
  async inspect(entries: readonly KeyTransferEntry[]): Promise<KeyTransferInspection> {
    this.#validate(entries);
    this.host.state.check();
    const response = await this.host.call((etcd) =>
      etcd.kv.txn({ success: entries.map((entry) => ({ request_range: { key: bytesOf(entry.key) } })) }),
    );
    let newKeys = 0n;
    let sameKeys = 0n;
    let changedKeys = 0n;
    let conflicts = 0n;
    entries.forEach((entry, index) => {
      const kv = response.responses[index]?.response_range?.kvs[0];
      if (kv === undefined) newKeys++;
      else if (kv.value.equals(bytesOf(entry.value))) sameKeys++;
      else changedKeys++;
      if (entry.expectedModRevision === null || (kv?.mod_revision ?? "0") !== entry.expectedModRevision) conflicts++;
    });
    return {
      newKeys: String(newKeys),
      changedKeys: String(changedKeys),
      sameKeys: String(sameKeys),
      conflicts: String(conflicts),
    };
  }
  async importChunk(entries: readonly KeyTransferEntry[], policy: KeyTransferPolicy): Promise<KeyTransferImported> {
    writable(this.host.readOnly);
    this.#validate(entries);
    this.host.state.check();
    if (!["skipExisting", "overwrite", "ifUnchanged"].includes(policy)) invalid("Unknown import conflict policy.");
    const operations: IRequestOp[] = [];
    const compares: ICompare[] = [];
    let skipped = 0;
    if (policy === "skipExisting") {
      const current = await this.host.call((etcd) =>
        etcd.kv.txn({
          success: entries.map((entry) => ({ request_range: { key: bytesOf(entry.key), keys_only: true } })),
        }),
      );
      entries.forEach((entry, index) => {
        if ((current.responses[index]?.response_range?.kvs.length ?? 0) > 0) {
          skipped++;
          return;
        }
        const key = bytesOf(entry.key);
        compares.push({ key, target: "Create", result: "Equal", create_revision: "0" });
        operations.push({ request_put: { key, value: bytesOf(entry.value), lease: "0" } });
      });
    } else
      for (const entry of entries) {
        const key = bytesOf(entry.key);
        if (policy === "ifUnchanged") {
          if (entry.expectedModRevision === null)
            invalid("Only-if-unchanged requires an expected revision for every key.");
          compares.push({ key, target: "Mod", result: "Equal", mod_revision: entry.expectedModRevision });
        }
        operations.push({ request_put: { key, value: bytesOf(entry.value), lease: "0" } });
      }
    const response = await this.host.call((etcd) => etcd.kv.txn({ compare: compares, success: operations }));
    if (!response.succeeded)
      guardFailed("Import chunk conflicted; nothing in this chunk was written. Inspect before trying again.");
    return { revision: response.header.revision, written: String(operations.length), skipped: String(skipped) };
  }
}
