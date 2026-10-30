import type {
  CoordinationCandidate,
  CoordinationPage,
  CoordinationPrefix,
  CoordinationQueue,
  CoordinationViewer,
} from "@table-craft/plugin-api";
import { bytesOf, keyBytesOf } from "./keyBytes.js";
import { budget, invalid, MAX_PAGE, type RuntimeHost } from "./runtime.js";
import { prefixEnd } from "./scan.js";

interface Position {
  binding: string;
  revision: string;
  next: string;
}
export class EtcdCoordination implements CoordinationViewer {
  readonly #prefixes: readonly CoordinationPrefix[];
  constructor(
    readonly host: RuntimeHost,
    lockPrefix: string,
    electionPrefix: string,
  ) {
    this.#prefixes = (
      [
        { id: "locks", kind: "lock", prefix: keyBytesOf(Buffer.from(lockPrefix)) },
        { id: "elections", kind: "election", prefix: keyBytesOf(Buffer.from(electionPrefix)) },
      ] satisfies CoordinationPrefix[]
    ).filter((entry) => entry.prefix.text.length > 0);
  }
  prefixes(): Promise<readonly CoordinationPrefix[]> {
    this.host.state.check();
    return Promise.resolve(this.#prefixes);
  }
  async read(prefixId: string, cursor: string | null, count: number): Promise<CoordinationPage> {
    budget(count, MAX_PAGE, "count");
    this.host.state.check();
    const prefix = this.#prefixes.find((entry) => entry.id === prefixId);
    if (prefix === undefined) invalid("Select a configured coordination prefix.");
    const binding = `coordination:${prefixId}`;
    const position = cursor === null ? null : this.host.state.read<Position>(cursor, binding);
    const start = bytesOf(prefix.prefix);
    const response = await this.host.call((etcd) =>
      etcd.kv.range({
        key: position === null ? start : Buffer.from(position.next, "hex"),
        range_end: prefixEnd(start),
        revision: position?.revision ?? "0",
        limit: count,
      }),
    );
    const revision = position?.revision ?? response.header.revision;
    const queues = new Map<string, { name: Buffer; candidates: CoordinationCandidate[]; recognized: boolean }>();
    for (const kv of response.kvs) {
      const slash = kv.key.lastIndexOf(Buffer.from("/"));
      const queueName = slash >= start.length ? kv.key.subarray(0, slash) : kv.key;
      const suffix = slash < 0 ? "" : kv.key.subarray(slash + 1).toString("ascii");
      const identity = queueName.toString("hex");
      const queue = queues.get(identity) ?? { name: queueName, candidates: [], recognized: true };
      const lease = BigInt(kv.lease);
      const hexLease = BigInt.asUintN(64, lease).toString(16);
      if (lease === 0n || !/^[0-9a-f]+$/.test(suffix) || suffix.replace(/^0+/, "") !== hexLease.replace(/^0+/, ""))
        queue.recognized = false;
      queue.candidates.push({
        key: keyBytesOf(kv.key),
        createRevision: kv.create_revision,
        leaseId: kv.lease,
        value: keyBytesOf(kv.value),
      });
      queues.set(identity, queue);
    }
    const result: CoordinationQueue[] = [...queues.values()].map((queue) => ({
      name: keyBytesOf(queue.name),
      kind: prefix.kind,
      candidates: queue.candidates.sort((a, b) =>
        BigInt(a.createRevision) < BigInt(b.createRevision)
          ? -1
          : BigInt(a.createRevision) > BigInt(b.createRevision)
            ? 1
            : Buffer.compare(bytesOf(a.key), bytesOf(b.key)),
      ),
      complete: position === null && !response.more && queue.recognized,
    }));
    const last = response.kvs.at(-1);
    return {
      revision,
      queues: result,
      cursor:
        response.more && last !== undefined
          ? this.host.state.cursor({
              binding,
              revision,
              next: Buffer.concat([last.key, Buffer.from([0])]).toString("hex"),
            } satisfies Position)
          : null,
    };
  }
}
