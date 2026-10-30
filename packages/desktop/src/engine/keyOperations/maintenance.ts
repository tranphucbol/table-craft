import { createHash, timingSafeEqual } from "node:crypto";
import type { ClusterManager } from "@table-craft/plugin-api";
import type { RequestOf } from "@table-craft/desktop/engine/protocol.js";
import type { EngineOperationFiles } from "./files.js";
import { type KeyTasks, type KeyJob } from "./tasks.js";
import { invalidOperation, quietClose, serviceMethod } from "./scope.js";

const SNAPSHOT_MAX_BYTES = 17_179_869_184;
const SNAPSHOT_HASH_BYTES = 32;
const SNAPSHOT_PAGE_BYTES = 512;
const MAX_STREAM_CHUNK = 16_777_216;

/** The consumer must await iterator completion; a failed final status must reject before publish. */
export async function* verifiedSnapshot(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  let tail = Buffer.alloc(0);
  let total = 0;
  for await (const chunk of source) {
    if (signal.aborted) throw invalidOperation("Snapshot cancelled.");
    if (chunk.byteLength > MAX_STREAM_CHUNK) throw invalidOperation("Snapshot exceeded the stream chunk budget.");
    total += chunk.byteLength;
    if (total > SNAPSHOT_MAX_BYTES) throw invalidOperation("Snapshot exceeds the file size budget.");
    const pending = Buffer.concat([tail, chunk]);
    const end = Math.max(0, pending.length - SNAPSHOT_HASH_BYTES);
    hash.update(pending.subarray(0, end));
    tail = Buffer.from(pending.subarray(end));
    yield chunk;
  }
  if (
    signal.aborted ||
    total <= SNAPSHOT_HASH_BYTES ||
    (total - SNAPSHOT_HASH_BYTES) % SNAPSHOT_PAGE_BYTES !== 0 ||
    tail.length !== SNAPSHOT_HASH_BYTES ||
    !timingSafeEqual(hash.digest(), tail)
  ) {
    throw invalidOperation("Snapshot did not finish with a valid backend checksum.");
  }
}

async function configuredEndpoints(cluster: ClusterManager, requested: readonly string[]): Promise<readonly string[]> {
  const configured = await serviceMethod(cluster, "endpoints")();
  const ids = configured.map((endpoint) => endpoint.id);
  if (requested.some((id) => !ids.includes(id)))
    throw invalidOperation("Only configured endpoint IDs can be used for maintenance.");
  return ids;
}

export function maintenanceOperations(tasks: KeyTasks, files: EngineOperationFiles | undefined) {
  function manager(job: KeyJob): ClusterManager {
    if (job.session.cluster === undefined) throw invalidOperation("The datasource has no cluster maintenance service.");
    return job.session.cluster;
  }

  return {
    defragment(request: RequestOf<"maintenance.defragmentStart">) {
      return tasks.start("defragment", "maintenance", true, async (job) => {
        const cluster = manager(job);
        await configuredEndpoints(cluster, request.endpointIds);
        const pending = [...request.endpointIds];
        let completed = 0;
        while (pending.length > 0) {
          job.check();
          const statuses = await Promise.all(pending.map((id) => serviceMethod(cluster, "status")(id)));
          if (statuses.some((status, index) => status.endpointId !== pending[index]))
            throw invalidOperation("Maintenance status did not match the configured endpoint.");
          const leaders = new Set(statuses.map((status) => status.leaderId).filter((id) => id !== null));
          if (leaders.size !== 1)
            throw invalidOperation("A single current leader could not be established; refresh cluster health.");
          const leader = statuses[0]?.leaderId;
          const chosen = statuses.find((status) => status.memberId !== leader) ?? statuses[0];
          if (chosen === undefined) break;
          job.beginWrite();
          await serviceMethod(cluster, "defragment")(chosen.endpointId);
          job.confirmed();
          pending.splice(pending.indexOf(chosen.endpointId), 1);
          completed += 1;
          job.progress(String(completed), String(request.endpointIds.length));
        }
      });
    },
    consistency(request: RequestOf<"maintenance.consistencyStart">) {
      return tasks.start("consistency", "maintenance", false, async (job) => {
        const cluster = manager(job);
        const all = await configuredEndpoints(cluster, request.endpointIds);
        if (all.length !== request.endpointIds.length || all.some((id) => !request.endpointIds.includes(id)))
          throw invalidOperation("Consistency checks must include every configured endpoint.");
        if (request.revision === "0")
          throw invalidOperation("Choose one explicit positive revision for every endpoint.");
        const hashes = [];
        for (const id of all) {
          job.check();
          const hash = await serviceMethod(cluster, "hash")(id, request.revision);
          if (hash.revision !== request.revision)
            throw invalidOperation("The server did not hash the requested revision.");
          hashes.push(hash);
          job.hashes([...hashes]);
          job.progress(String(hashes.length), String(all.length));
        }
      });
    },
    snapshot(request: RequestOf<"maintenance.snapshotStart">) {
      if (files === undefined) throw invalidOperation("The host has not installed authorized file operations.");
      return tasks.start("snapshot", "maintenance", false, async (job) => {
        const cluster = manager(job);
        await configuredEndpoints(cluster, [request.endpointId]);
        const snapshot = await serviceMethod(cluster, "snapshot")(request.endpointId);
        const close = () => {
          void quietClose(snapshot);
        };
        job.signal.addEventListener("abort", close, { once: true });
        try {
          job.check();
          let completed = 0n;
          async function* counted() {
            for await (const chunk of verifiedSnapshot(snapshot.chunks, job.signal)) {
              job.check();
              completed += BigInt(chunk.byteLength);
              job.progress(String(completed), null);
              yield chunk;
            }
          }
          await files.publish(request.fileGrantId, "cluster.snapshot", counted(), SNAPSHOT_MAX_BYTES, job.signal, () =>
            quietClose(snapshot),
          );
          job.check();
        } finally {
          job.signal.removeEventListener("abort", close);
          await quietClose(snapshot);
        }
      });
    },
  };
}
