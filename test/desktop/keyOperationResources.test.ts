import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KeyRecord, KeyWatchEvent } from "@table-craft/plugin-api";
import { KeyWatchRing } from "@table-craft/desktop/engine/keyOperations/watches.js";
import { verifiedSnapshot } from "@table-craft/desktop/engine/keyOperations/maintenance.js";
import { exportHeader, exportRecord, parseTransfer } from "@table-craft/desktop/engine/keyOperations/transferFormat.js";
import { EnginePrivateOperations } from "@table-craft/desktop/engine/privateOperations.js";
import type { EngineConnection } from "@table-craft/desktop/engine/engine.js";

const revision = { createRevision: "1", modRevision: "9007199254740993", version: "1", lease: "0" };
const key = { text: "/a", hex: null };
const event: KeyWatchEvent = { kind: "PUT", key, value: key, previous: null, revision };
const header = { clusterId: "123", namespace: { text: "/app/", hex: null }, revision: revision.modRevision };
const PRIVATE_REQUEST = "table-craft:private-request";
const PRIVATE_RESPONSE = "table-craft:private-response";

async function* bytes(value: Uint8Array) {
  await Promise.resolve();
  yield value;
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function parsed(text: string) {
  const parts = [];
  for await (const part of parseTransfer(bytes(Buffer.from(text)))) parts.push(part);
  return parts;
}

describe("advanced engine resource boundaries", () => {
  it("givenBoundedRing_whenEvictedAndCleared_thenSequencesNeverRepeatAndLossRemainsVisible", () => {
    const ring = new KeyWatchRing(2, 10_000);
    ring.append(event);
    ring.append(event);
    ring.append(event);
    expect(ring.window(null, 10, 10_000)).toMatchObject({
      oldestSequence: "2",
      newestSequence: "3",
      evictedEvents: "1",
    });
    expect(ring.window("2", 10, 10_000).rows.map((row) => row.sequence)).toEqual(["3"]);
    ring.clear();
    ring.append(event);
    expect(ring.window(null, 10, 10_000)).toMatchObject({
      oldestSequence: "4",
      newestSequence: "4",
      evictedEvents: "3",
    });
    expect(ring.window(null, 10, 1).rows).toEqual([]);
  });

  it("givenOversizedEvent_whenAppended_thenNoTruncationOrSequenceAdvance", () => {
    const ring = new KeyWatchRing(2, 1);
    expect(ring.append(event)).toBe(false);
    expect(ring.window(null, 1, 100).newestSequence).toBeNull();
  });

  it("givenBinaryRecord_whenTransferred_thenBytesAndLargeDecimalRevisionRoundTrip", async () => {
    const record: KeyRecord = {
      key: { text: "\\xff", hex: "ff" },
      value: { text: "\\x00\\xfe", hex: "00fe" },
      revision,
    };
    const parts = await parsed(exportHeader(header) + exportRecord(record) + "]}");
    expect(parts).toEqual([
      { kind: "header", header },
      { kind: "record", entry: { key: record.key, value: record.value, expectedModRevision: revision.modRevision } },
    ]);
  });

  it("givenMalformedTrailingOrDuplicateRecords_whenParsed_thenEntireDocumentRejected", async () => {
    const record = exportRecord({ key, value: key, revision });
    await expect(parsed(exportHeader(header) + record + "," + record + "]}")).rejects.toThrow("duplicate");
    await expect(parsed(exportHeader(header) + record + "]} trailing")).rejects.toThrow();
    await expect(parsed(exportHeader(header) + record + ",]}")).rejects.toThrow();
    await expect(parsed(exportHeader(header) + record)).rejects.toThrow();
  });

  it("givenSnapshot_whenChecksumValidButFinalStatusFails_thenSourceRejectsBeforePublish", async () => {
    const backend = Buffer.alloc(512, 7);
    const snapshot = Buffer.concat([backend, createHash("sha256").update(backend).digest()]);
    const signal = new AbortController().signal;
    expect(await collect(verifiedSnapshot(bytes(snapshot), signal))).toEqual(snapshot);
    const corrupted = Buffer.from(snapshot);
    corrupted[0] = 0;
    await expect(collect(verifiedSnapshot(bytes(corrupted), signal))).rejects.toThrow("checksum");
    async function* failedStatus() {
      await Promise.resolve();
      yield snapshot;
      throw new Error("non-OK status");
    }
    await expect(collect(verifiedSnapshot(failedStatus(), signal))).rejects.toThrow("non-OK");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(collect(verifiedSnapshot(bytes(snapshot), cancelled.signal))).rejects.toThrow();
  });

  it("givenOwnerBoundPrivateControl_whenSecretDelivered_thenNoOrdinaryCallAndBytesAreZeroed", async () => {
    const messages: unknown[] = [];
    const control = new EnginePrivateOperations((message) => messages.push(message));
    const apply = vi.fn().mockResolvedValue(undefined);
    const handle = vi.fn();
    const connection: EngineConnection = {
      handle,
      applyAccessSecret: apply,
      close: vi.fn().mockResolvedValue(undefined),
    };
    control.bind("owner", Promise.resolve(connection));
    const password = new TextEncoder().encode("private-password");
    await control.receive({
      kind: PRIVATE_REQUEST,
      id: "secret",
      ownerId: "owner",
      op: "secret.apply",
      payload: { sessionId: "session", user: "new-user", action: "create", password },
    });
    expect(apply).toHaveBeenCalledWith(
      { kind: "createUser", user: "new-user", password: "private-password" },
      "session",
    );
    expect(handle).not.toHaveBeenCalled();
    expect([...password].every((byte) => byte === 0)).toBe(true);
    expect(messages).toEqual([{ kind: PRIVATE_RESPONSE, id: "secret", ok: true, value: null }]);
    await control.close();
  });

  it("givenPrivatePublication_whenPulled_thenBoundedChunksAndCleanCompletionAreRequired", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const control = new EnginePrivateOperations((message) => messages.push(message as Record<string, unknown>));
    control.bind(
      "owner",
      Promise.resolve({ handle: vi.fn(), applyAccessSecret: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }),
    );
    const publishing = control
      .files("owner")
      .publish("grant", "transfer.export", bytes(Buffer.alloc(70_000)), 100_000, new AbortController().signal);
    const publication = messages[0]!;
    const payload = { streamId: (publication.payload as { streamId: string }).streamId };
    await control.receive({ kind: PRIVATE_REQUEST, id: "one", ownerId: "owner", op: "stream.next", payload });
    expect((messages.at(-1)?.value as { chunk: Uint8Array }).chunk.byteLength).toBe(65_536);
    await control.receive({ kind: PRIVATE_REQUEST, id: "two", ownerId: "owner", op: "stream.next", payload });
    expect((messages.at(-1)?.value as { chunk: Uint8Array }).chunk.byteLength).toBe(4_464);
    await control.receive({ kind: PRIVATE_REQUEST, id: "end", ownerId: "owner", op: "stream.next", payload });
    expect(messages.at(-1)?.value).toEqual({ done: true, clean: true });
    await control.receive({ kind: PRIVATE_RESPONSE, id: publication.id, ok: true, value: { bytes: 70_000 } });
    await publishing;
    await control.close();
  });

  it("givenForeignOwner_whenStreamPulledOrSecretApplied_thenFixedFailureWithoutData", async () => {
    const messages: unknown[] = [];
    const control = new EnginePrivateOperations((message) => messages.push(message));
    await control.receive({
      kind: PRIVATE_REQUEST,
      id: "attempt",
      ownerId: "foreign",
      op: "secret.apply",
      payload: { password: "do-not-echo" },
    });
    expect(messages).toEqual([{ kind: PRIVATE_RESPONSE, id: "attempt", ok: false }]);
    await control.close();
  });
});
