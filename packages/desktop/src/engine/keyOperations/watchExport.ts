import type { KeyWatchSummary, KeyWatchWindow, RequestOf } from "@table-craft/desktop/engine/protocol.js";
import { KEY_WATCH_MAX_RING_BYTES } from "@table-craft/desktop/engine/protocol.js";
import type { EngineOperationFiles } from "./files.js";
import { invalidOperation } from "./scope.js";
import type { KeyTasks } from "./tasks.js";
import type { KeyWatches } from "./watches.js";

const MAX_EXPORTS = 2;
const ENVELOPE_BUDGET_BYTES = 16 * 1024 * 1024;
export const WATCH_EXPORT_MAX_BYTES = KEY_WATCH_MAX_RING_BYTES + ENVELOPE_BUDGET_BYTES;

export interface RetainedWatchCapture {
  readonly chunks: readonly Uint8Array[];
  readonly bytes: number;
  readonly events: string;
  dispose(): void;
}

/** Serializing synchronously pins both events and metadata before live watching can advance. */
export function captureRetainedWatch(
  summary: KeyWatchSummary,
  window: KeyWatchWindow,
  maxBytes: number,
): RetainedWatchCapture {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const line = (value: unknown) => {
    const chunk = Buffer.from(JSON.stringify(value) + "\n");
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      for (const held of [chunk, ...chunks]) held.fill(0);
      chunks.length = 0;
      throw invalidOperation(
        "Retained Watch exports exceed the capture budget. Wait for an export to finish before trying again.",
      );
    }
    chunks.push(chunk);
  };
  const events = String(window.rows.length);
  line({
    type: "header",
    format: "tablecraft-watch",
    version: 1,
    retainedOnly: true,
    watchId: summary.watchId,
    request: summary.request,
    state: summary.state,
    completedRevision: summary.completedRevision,
    gap: summary.gap,
    evictedEvents: window.evictedEvents,
    oldestSequence: window.oldestSequence,
    newestSequence: window.newestSequence,
    eventCount: events,
  });
  for (const row of window.rows) line({ type: "event", sequence: row.sequence, event: row.event });
  return {
    chunks,
    bytes,
    events,
    dispose: () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    },
  };
}

export function watchExportOperations(watches: KeyWatches, tasks: KeyTasks, files: EngineOperationFiles | undefined) {
  let active = 0;
  let retainedBytes = 0;
  return {
    start(request: RequestOf<"watch.exportStart">) {
      if (files === undefined) throw invalidOperation("The host has not installed authorized file operations.");
      if (active >= MAX_EXPORTS)
        throw invalidOperation("Two Watch exports are already running. Wait for one to finish.");
      const capture = watches.capture(request.watchId, WATCH_EXPORT_MAX_BYTES - retainedBytes);
      active++;
      retainedBytes += capture.bytes;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        retainedBytes -= capture.bytes;
        capture.dispose();
      };
      try {
        return tasks.startLocal("watchExport", "watch", async (job) => {
          try {
            let completed = 0n;
            job.progress("0", capture.events);
            async function* source() {
              await Promise.resolve();
              for (const [index, chunk] of capture.chunks.entries()) {
                job.check();
                yield chunk;
                if (index > 0) job.progress(String(++completed), capture.events);
              }
              job.check();
            }
            await files.publish(request.fileGrantId, "watch.export", source(), capture.bytes, job.signal);
            job.check();
          } finally {
            release();
          }
        });
      } catch (cause) {
        release();
        throw cause;
      }
    },
  };
}
