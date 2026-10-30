import type {
  KeyChildrenPage,
  KeyChildrenRequest,
  KeyDeletePreview,
  KeyDeleteResult,
  KeyRange,
  KeyRangeCount,
} from "@table-craft/plugin-api";
import { bytesOf, keyBytesOf } from "./keyBytes.js";
import { revisionOf } from "./history.js";
import {
  budget,
  database,
  guardFailed,
  invalid,
  logicalRange,
  MAX_PAGE,
  writable,
  type RuntimeHost,
} from "./runtime.js";
import { NO_END, prefixEnd } from "./scan.js";

const SAMPLE_COUNT = 20;
const MAX_TIMEOUT = 5000;
interface Position {
  binding: string;
  revision: string;
  next: string;
}
interface DeletePreview {
  kind: "delete";
  range: KeyRange;
  revision: string;
}

export class EtcdKeyRanges {
  constructor(
    readonly host: RuntimeHost,
    readonly delimiter: string,
  ) {}
  async countRange(db: number, range: KeyRange): Promise<KeyRangeCount> {
    database(db);
    this.host.state.check();
    const result = await this.host.call((etcd) => etcd.kv.range({ ...logicalRange(range), count_only: true }));
    return { revision: result.header.revision, keys: result.count, leasedKeys: null };
  }
  async prepareDelete(db: number, range: KeyRange): Promise<KeyDeletePreview> {
    database(db);
    this.host.state.check();
    const counts = await this.countRange(db, range);
    const result = await this.host.call((etcd) =>
      etcd.kv.range({ ...logicalRange(range), revision: counts.revision, keys_only: true, limit: SAMPLE_COUNT }),
    );
    return {
      token: this.host.state.token({ kind: "delete", range, revision: counts.revision } satisfies DeletePreview),
      revision: counts.revision,
      counts,
      sampleKeys: result.kvs.map((kv) => keyBytesOf(kv.key)),
      guard: "noNewOrModifiedKeys",
    };
  }
  async deletePrepared(token: string): Promise<KeyDeleteResult> {
    writable(this.host.readOnly);
    const preview = this.host.state.take<DeletePreview>(token);
    if (preview.kind !== "delete") invalid("This is not a key deletion preview token.");
    const range = logicalRange(preview.range);
    const response = await this.host.call((etcd) =>
      etcd.kv.txn({
        compare: [
          { ...range, target: "Mod", result: "Less", mod_revision: (BigInt(preview.revision) + 1n).toString() },
        ],
        success: [{ request_delete_range: range }],
      }),
    );
    if (!response.succeeded)
      guardFailed("Keys were created or modified after preview. Prepare a new deletion preview.");
    return {
      revision: response.header.revision,
      deleted: response.responses[0]?.response_delete_range?.deleted ?? "0",
    };
  }
  async children(request: KeyChildrenRequest): Promise<KeyChildrenPage> {
    database(request.database);
    budget(request.count, MAX_PAGE, "count");
    budget(request.timeoutMs, MAX_TIMEOUT, "timeoutMs");
    this.host.state.check();
    const binding = JSON.stringify({ kind: "children", range: request.range, parent: request.parent });
    const parent = bytesOf(request.parent);
    const delimiter = Buffer.from(this.delimiter);
    const wanted = logicalRange(request.range);
    let from = parent.length === 0 ? NO_END : parent;
    if (Buffer.compare(wanted.key, from) > 0) from = wanted.key;
    let end = parent.length === 0 ? NO_END : prefixEnd(parent);
    if (wanted.range_end === undefined) end = Buffer.concat([wanted.key, NO_END]);
    else if (!wanted.range_end.equals(NO_END) && (end.equals(NO_END) || Buffer.compare(wanted.range_end, end) < 0))
      end = wanted.range_end;
    const position = request.cursor === null ? null : this.host.state.read<Position>(request.cursor, binding);
    if (position !== null) from = Buffer.from(position.next, "hex");
    let revision = position?.revision ?? "0";
    const children: KeyChildrenPage["children"][number][] = [];
    const deadline = Date.now() + request.timeoutMs;
    let complete = false;
    while (children.length < request.count && Date.now() < deadline) {
      if (!end.equals(NO_END) && Buffer.compare(from, end) >= 0) {
        complete = true;
        break;
      }
      const result = await this.host.call((etcd) =>
        etcd.kv.range({ key: from, range_end: end, keys_only: true, limit: 1, revision }, { deadline }),
      );
      if (revision === "0") revision = result.header.revision;
      const kv = result.kvs[0];
      if (kv === undefined) {
        complete = true;
        break;
      }
      if (!kv.key.subarray(0, parent.length).equals(parent)) {
        complete = true;
        break;
      }
      let offset = parent.length;
      if (offset === 0 && kv.key.subarray(0, delimiter.length).equals(delimiter)) offset += delimiter.length;
      const split = kv.key.indexOf(delimiter, offset);
      if (delimiter.length > 0 && split >= 0) {
        const folder = kv.key.subarray(0, split + delimiter.length);
        children.push({ kind: "folder", key: keyBytesOf(folder) });
        from = prefixEnd(folder);
        if (from.equals(NO_END)) {
          complete = true;
          break;
        }
      } else {
        children.push({ kind: "key", key: keyBytesOf(kv.key), revision: revisionOf(kv) });
        from = Buffer.concat([kv.key, NO_END]);
      }
    }
    return {
      revision,
      children,
      cursor: complete
        ? null
        : this.host.state.cursor({ binding, revision, next: from.toString("hex") } satisfies Position),
    };
  }
}
