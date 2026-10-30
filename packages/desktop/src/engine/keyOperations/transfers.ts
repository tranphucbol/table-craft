import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  KeyTransfer,
  KeyTransferEntry,
  KeyTransferInspection,
  KeyRange,
  KeyTransferPolicy,
} from "@table-craft/plugin-api";
import {
  COMMAND_TXN_MAX_OPERATIONS,
  KEY_ADVANCED_MAX_BYTES,
  type RequestOf,
} from "@table-craft/desktop/engine/protocol.js";
import { KeyCaptures, type KeyCapture } from "./captures.js";
import type { EngineOperationFiles } from "./files.js";
import { type KeyOperationScope, definitelyNotApplied, invalidOperation, quietClose, serviceMethod } from "./scope.js";
import { type KeyTasks, type KeyJob } from "./tasks.js";
import {
  exportHeader,
  exportRecord,
  inRange,
  keyBuffer,
  keyIdentity,
  parseTransfer,
  TRANSFER_MAX_FILE_BYTES,
  TRANSFER_MAX_RECORDS,
  type TransferHeader,
} from "./transferFormat.js";

const CHUNK_MAX_BYTES = 786_432;
const ENTRY_OVERHEAD_BYTES = 256;
const JOURNAL_VERSION = 1;

interface ImportJournal {
  readonly version: number;
  readonly digest: string;
  readonly database: number;
  readonly range: KeyRange;
  readonly policy: KeyTransferPolicy;
  readonly clusterId: string;
  readonly namespace: string;
  confirmedEntries: string;
  written: string;
  skipped: string;
  uncertain: boolean;
}

async function validateCapture(
  capture: KeyCapture,
  range: KeyRange,
): Promise<{ header: TransferHeader; count: number }> {
  let header: TransferHeader | null = null;
  let count = 0;
  for await (const part of parseTransfer(createReadStream(capture.path))) {
    if (part.kind === "header") header = part.header;
    else {
      if (!inRange(part.entry.key, range))
        throw invalidOperation("The import contains keys outside the selected range.");
      count += 1;
    }
  }
  if (header === null) throw invalidOperation("Import has no versioned metadata.");
  return { header, count };
}

async function* chunks(
  capture: KeyCapture,
  policy: KeyTransferPolicy,
  from: bigint,
): AsyncGenerator<readonly KeyTransferEntry[]> {
  let index = 0n;
  let entries: KeyTransferEntry[] = [];
  let bytes = 0;
  let operations = 0;
  for await (const part of parseTransfer(createReadStream(capture.path))) {
    if (part.kind !== "record") continue;
    if (index++ < from) continue;
    const entry = part.entry;
    const cost = keyBuffer(entry.key).length + keyBuffer(entry.value).length + ENTRY_OVERHEAD_BYTES;
    const ops = policy === "overwrite" ? 1 : 2;
    if (cost > CHUNK_MAX_BYTES) throw invalidOperation("One import entry exceeds the safe transaction byte budget.");
    if (entries.length > 0 && (bytes + cost > CHUNK_MAX_BYTES || operations + ops > COMMAND_TXN_MAX_OPERATIONS)) {
      yield entries;
      entries = [];
      bytes = 0;
      operations = 0;
    }
    entries.push(entry);
    bytes += cost;
    operations += ops;
  }
  if (entries.length > 0) yield entries;
}

export function keyTransferOperations(
  scope: KeyOperationScope,
  tasks: KeyTasks,
  files: EngineOperationFiles | undefined,
) {
  const captures = new KeyCaptures(scope, files);

  function transfer(job: KeyJob): KeyTransfer {
    if (job.session.keyTransfer === undefined) throw invalidOperation("The datasource has no key transfer service.");
    return job.session.keyTransfer;
  }

  return {
    async preview(request: RequestOf<"keyTransfer.previewImport">): Promise<KeyTransferInspection> {
      scope.capability("bulkTransfer");
      const capture = await captures.capture(request.fileGrantId);
      await captures.verify(capture);
      await validateCapture(capture, request.range);
      const session = await scope.open("bulkTransfer");
      try {
        const totals = { newKeys: 0n, changedKeys: 0n, sameKeys: 0n, conflicts: 0n };
        for await (const entries of chunks(capture, "ifUnchanged", 0n)) {
          scope.live();
          const inspected = await serviceMethod(session.keyTransfer, "inspect")(entries);
          for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += BigInt(inspected[key]);
        }
        return {
          newKeys: String(totals.newKeys),
          changedKeys: String(totals.changedKeys),
          sameKeys: String(totals.sameKeys),
          conflicts: String(totals.conflicts),
        };
      } finally {
        await scope.release(session);
      }
    },

    import(request: RequestOf<"keyTransfer.importStart">) {
      scope.capability("bulkTransfer");
      scope.writable();
      let capture: KeyCapture | null = null;
      let journal: ImportJournal | null = null;
      const run = async (job: KeyJob) => {
        job.check();
        capture ??= await captures.capture(request.fileGrantId);
        await captures.verify(capture);
        const validated = await validateCapture(capture, request.range);
        // Reject every oversized entry before any mutation, not halfway through an import.
        for await (const entries of chunks(capture, request.policy, 0n)) {
          void entries;
          job.check();
        }
        const service = transfer(job);
        const identity = await serviceMethod(
          service,
          "exportPage",
        )({
          database: request.database,
          range: request.range,
          cursor: null,
          count: 1,
          maxBytes: KEY_ADVANCED_MAX_BYTES,
        });
        const namespace = keyIdentity(identity.namespace);
        if (journal === null) {
          if (
            request.policy === "ifUnchanged" &&
            (identity.clusterId !== validated.header.clusterId || namespace !== keyIdentity(validated.header.namespace))
          )
            throw invalidOperation("Revision guards cannot be imported into a different cluster or namespace.");
          journal = {
            version: JOURNAL_VERSION,
            digest: capture.digest,
            database: request.database,
            range: request.range,
            policy: request.policy,
            clusterId: identity.clusterId,
            namespace,
            confirmedEntries: "0",
            written: "0",
            skipped: "0",
            uncertain: false,
          };
        }
        if (
          journal.uncertain ||
          journal.digest !== capture.digest ||
          journal.clusterId !== identity.clusterId ||
          journal.namespace !== namespace
        )
          throw invalidOperation("The import identity or confirmed journal boundary no longer matches.");
        const save = () =>
          writeFile(join(capture!.directory, "journal.json"), JSON.stringify(journal), { mode: 0o600 });
        await save();
        job.progress(journal.confirmedEntries, String(validated.count));
        for await (const entries of chunks(capture, request.policy, BigInt(journal.confirmedEntries))) {
          job.check();
          journal.uncertain = true;
          await save();
          job.beginWrite();
          const result = await serviceMethod(service, "importChunk")(entries, request.policy).catch(
            async (cause: unknown) => {
              if (definitelyNotApplied(cause)) {
                journal!.uncertain = false;
                job.confirmed();
                await save();
              }
              throw cause;
            },
          );
          if (BigInt(result.written) + BigInt(result.skipped) !== BigInt(entries.length))
            throw invalidOperation("The import chunk did not report a complete confirmed result.");
          journal.confirmedEntries = String(BigInt(journal.confirmedEntries) + BigInt(entries.length));
          journal.written = String(BigInt(journal.written) + BigInt(result.written));
          journal.skipped = String(BigInt(journal.skipped) + BigInt(result.skipped));
          journal.uncertain = false;
          await save();
          job.confirmed();
          job.progress(journal.confirmedEntries, String(validated.count));
        }
      };
      return tasks.start("import", "bulkTransfer", true, run, () => run);
    },

    export(request: RequestOf<"keyTransfer.exportStart">) {
      scope.capability("bulkTransfer");
      if (files === undefined) throw invalidOperation("The host has not installed authorized file operations.");
      return tasks.start("export", "bulkTransfer", false, async (job) => {
        const service = transfer(job);
        async function* source() {
          let cursor: string | null = null;
          let header: TransferHeader | null = null;
          let count = 0;
          let first = true;
          let bytes = 0;
          let lastKey: Buffer | null = null;
          const cursors = new Set<string>();
          const output = (text: string) => {
            const chunk = Buffer.from(text);
            bytes += chunk.byteLength;
            if (bytes > TRANSFER_MAX_FILE_BYTES) throw invalidOperation("Export exceeds its file size budget.");
            return chunk;
          };
          do {
            job.check();
            const page = await serviceMethod(
              service,
              "exportPage",
            )({
              database: request.database,
              range: request.range,
              cursor,
              count: 64,
              maxBytes: KEY_ADVANCED_MAX_BYTES,
            });
            if (header === null) {
              header = { clusterId: page.clusterId, namespace: page.namespace, revision: page.revision };
              yield output(exportHeader(header));
            } else if (
              page.clusterId !== header.clusterId ||
              keyIdentity(page.namespace) !== keyIdentity(header.namespace) ||
              page.revision !== header.revision
            )
              throw invalidOperation("Export snapshot identity changed between pages.");
            for (const record of page.records) {
              job.check();
              const key = keyBuffer(record.key);
              if (!inRange(record.key, request.range) || (lastKey !== null && key.compare(lastKey) <= 0))
                throw invalidOperation("Export returned duplicate, unordered or out-of-range keys.");
              lastKey = key;
              count += 1;
              if (count > TRANSFER_MAX_RECORDS) throw invalidOperation("Export exceeds its record budget.");
              yield output((first ? "" : ",\n") + exportRecord(record));
              first = false;
            }
            cursor = page.cursor;
            if (cursor !== null) {
              if (cursors.has(cursor)) throw invalidOperation("Export cursor did not make progress.");
              cursors.add(cursor);
            }
            job.progress(String(count), null);
          } while (cursor !== null);
          yield output("\n]}\n");
        }
        await files.publish(request.fileGrantId, "transfer.export", source(), TRANSFER_MAX_FILE_BYTES, job.signal, () =>
          quietClose(job.session),
        );
        job.check();
      });
    },
  };
}
