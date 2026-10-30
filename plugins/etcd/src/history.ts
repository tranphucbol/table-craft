import {
  PluginError,
  type KeyHistoryEvent,
  type KeyHistoryGap,
  type KeyHistoryPage,
  type KeyHistoryRequest,
  type KeyHistoryStopReason,
} from "@table-craft/plugin-api";
import type { IDuplexStream, IKeyValue, IWatchRequest, IWatchResponse } from "etcd3";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Call } from "./admin.js";
import { closeStream, errorText } from "./client.js";
import { bytesOf, keyBytesOf } from "./keyBytes.js";

const MAX_EVENTS = 100;
const MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const DECIMAL = /^(0|[1-9]\d*)$/;
const MAX_CURSOR_LENGTH = 2048;
const SIGNING_KEY_BYTES = 32;
const COMPACTED = /required revision has been compacted/i;

/** Session-private authentication keeps cursor state bounded without retaining searches. */
export class HistoryState {
  #secret: Buffer | null = randomBytes(SIGNING_KEY_BYTES);
  readonly #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  checkOpen(): void {
    if (this.#secret === null) throw new PluginError("connectionLost", "The connection to etcd is closed.");
  }

  sign(payload: string): string {
    if (this.#secret === null) throw new PluginError("connectionLost", "The connection to etcd is closed.");
    return createHmac("sha256", this.#secret).update(payload).digest("base64url");
  }

  close(): void {
    this.#secret?.fill(0);
    this.#secret = null;
    this.#controller.abort();
  }
}

interface Position {
  readonly key: string;
  readonly snapshot: string;
  readonly terminal: string | null;
  readonly next: string;
  readonly unavailable: string | null;
}

export function revisionOf(kv: IKeyValue) {
  return { createRevision: kv.create_revision, modRevision: kv.mod_revision, version: kv.version, lease: kv.lease };
}

function invalid(message: string): never {
  throw new PluginError("statementFailed", `etcd history: ${message}`);
}

function positionOf(cursor: string, key: string, state: HistoryState): Position {
  try {
    if (cursor.length > MAX_CURSOR_LENGTH) throw new Error();
    const [payload, signature, extra] = cursor.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) throw new Error();
    const expected = Buffer.from(state.sign(payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Position;
    if (
      value.key !== key ||
      !DECIMAL.test(value.snapshot) ||
      !DECIMAL.test(value.next) ||
      (value.terminal !== null && !DECIMAL.test(value.terminal)) ||
      (value.unavailable !== null && !DECIMAL.test(value.unavailable)) ||
      BigInt(value.next) < 1n ||
      BigInt(value.snapshot) < BigInt(value.terminal ?? "0")
    )
      throw new Error();
    return value;
  } catch {
    return invalid("invalid cursor. Start a new history search.");
  }
}

async function terminalVersion(
  call: Call,
  key: Buffer,
  position: Position,
  deadline: number,
): Promise<IKeyValue | null> {
  const read = async (revision?: string) => {
    const response = await call((etcd) =>
      etcd.kv.range({ key, ...(revision === undefined ? {} : { revision }) }, { deadline }),
    );
    const kv = response.kvs[0];
    return kv?.mod_revision === position.terminal ? kv : null;
  };
  const current = await read();
  if (current !== null) return current;
  try {
    return await read(position.snapshot);
  } catch (cause) {
    // The key changed after the pinned snapshot and compaction reached past it: that version is gone.
    if (COMPACTED.test(errorText(cause))) return null;
    throw cause;
  }
}

/** Replay ends only at the pinned key's actual terminal event, never at a watch header. */
export async function keyHistory(call: Call, request: KeyHistoryRequest, state: HistoryState): Promise<KeyHistoryPage> {
  state.checkOpen();
  if (![request.count, request.maxBytes, request.timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
    return invalid("count, maxBytes and timeoutMs must be positive integers.");
  }
  if (request.count > MAX_EVENTS || request.maxBytes > MAX_BYTES || request.timeoutMs > MAX_TIMEOUT_MS) {
    return invalid("requested budget exceeds 100 events, 1 MiB or 5000 ms. Reduce the history page limits.");
  }
  const count = Math.min(request.count, MAX_EVENTS);
  const maxBytes = Math.min(request.maxBytes, MAX_BYTES);
  const deadline = Date.now() + Math.min(request.timeoutMs, MAX_TIMEOUT_MS);
  const key = bytesOf(request.key);
  const keyIdentity = createHash("sha256").update(key).digest("hex");
  let position: Position;
  if (request.cursor !== null) position = positionOf(request.cursor, keyIdentity, state);
  else {
    const snapshot = await call((etcd) => etcd.kv.range({ key, keys_only: true }, { deadline }));
    position = {
      key: keyIdentity,
      snapshot: snapshot.header.revision,
      terminal: snapshot.kvs[0]?.mod_revision ?? null,
      next: "1",
      unavailable: null,
    };
  }
  const events: KeyHistoryEvent[] = [];
  let usedBytes = 0;
  let reachedEnd = false;
  let stopReason: KeyHistoryStopReason = "deadline";
  let retries = 0;
  const gaps = (): KeyHistoryGap[] =>
    position.unavailable === null ? [] : [{ fromRevision: "1", toRevision: position.unavailable, reason: "compacted" }];
  // An absent key has no terminal event to prove replay completion. Do not turn idle into success.
  while (Date.now() < deadline) {
    let compacted: string | null = null;
    await call(async (etcd) => {
      const stream: IDuplexStream<IWatchRequest, IWatchResponse> = await etcd.watchClient.watch({ deadline });
      if (state.signal.aborted || Date.now() >= deadline) {
        closeStream(stream);
        state.checkOpen();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          state.signal.removeEventListener("abort", onClose);
          closeStream(stream);
          if (error === undefined) resolve();
          else reject(error instanceof Error ? error : new Error(errorText(error)));
        };
        const timer = setTimeout(() => finish(), Math.max(1, deadline - Date.now()));
        const onClose = () => finish(new PluginError("connectionLost", "The connection to etcd is closed."));
        state.signal.addEventListener("abort", onClose, { once: true });
        stream.on("error", (error) => {
          if (Date.now() >= deadline) finish();
          else finish(error);
        });
        stream.on("end", () => finish());
        stream.on("data", (response) => {
          if (done) return;
          if (response.canceled) {
            if (BigInt(response.compact_revision || "0") > 0n) {
              compacted = response.compact_revision;
              finish();
            } else finish(new PluginError("statementFailed", `etcd history canceled: ${response.cancel_reason}`));
            return;
          }
          for (const event of response.events) {
            const kv = event.kv;
            if (!kv.key.equals(key) || BigInt(kv.mod_revision) < BigInt(position.next)) continue;
            if (BigInt(kv.mod_revision) > BigInt(position.terminal ?? position.snapshot)) {
              // In particular, this cannot prove an absent key's historical replay was complete.
              finish();
              return;
            }
            const size = kv.key.length + kv.value.length;
            if (size > maxBytes && events.length === 0) {
              finish(
                new PluginError(
                  "statementFailed",
                  "etcd history event exceeds the byte limit. Increase maxBytes or inspect the current value.",
                ),
              );
              return;
            }
            if (usedBytes + size > maxBytes) {
              stopReason = "byteLimit";
              finish();
              return;
            }
            usedBytes += size;
            events.push({
              ...revisionOf(kv),
              kind: event.type === "Delete" ? "DELETE" : "PUT",
              key: keyBytesOf(kv.key),
              value: event.type === "Delete" ? null : keyBytesOf(kv.value),
            });
            position = { ...position, next: (BigInt(kv.mod_revision) + 1n).toString() };
            if (kv.mod_revision === position.terminal) {
              reachedEnd = true;
              stopReason = "snapshotEnd";
              finish();
              return;
            }
            if (events.length >= count) {
              stopReason = "pageLimit";
              finish();
              return;
            }
          }
        });
        try {
          stream.write({ create_request: { key, start_revision: position.next, progress_notify: false } });
        } catch (error) {
          finish(error);
        }
      });
    });
    if (compacted === null) break;
    const compactRevision: string = compacted;
    position = { ...position, unavailable: compactRevision, next: (BigInt(compactRevision) + 1n).toString() };
    const terminalRevision = position.terminal;
    if (terminalRevision !== null && BigInt(compactRevision) >= BigInt(terminalRevision)) {
      stopReason = "compacted";
      // Compaction keeps a live key's latest version, so the terminal event is still readable.
      const terminal = await terminalVersion(call, key, position, deadline);
      if (terminal !== null && events.at(-1)?.modRevision !== terminalRevision) {
        const size = terminal.key.length + terminal.value.length;
        if (size > maxBytes && events.length === 0) {
          throw new PluginError(
            "statementFailed",
            "etcd history event exceeds the byte limit. Increase maxBytes or inspect the current value.",
          );
        }
        if (usedBytes + size > maxBytes || events.length >= count) {
          stopReason = usedBytes + size > maxBytes ? "byteLimit" : "pageLimit";
          // A watch from the terminal revision is either compacted again or replays that event.
          position = { ...position, next: terminalRevision };
          break;
        }
        usedBytes += size;
        events.push({
          ...revisionOf(terminal),
          kind: "PUT",
          key: keyBytesOf(terminal.key),
          value: keyBytesOf(terminal.value),
        });
      }
      reachedEnd = true;
      break;
    }
    if (++retries > MAX_RETRIES) {
      stopReason = "compacted";
      break;
    }
  }
  state.checkOpen();
  const payload = Buffer.from(JSON.stringify(position)).toString("base64url");
  return {
    events,
    snapshotRevision: position.snapshot,
    terminalRevision: position.terminal,
    cursor: reachedEnd ? null : `${payload}.${state.sign(payload)}`,
    complete: reachedEnd && position.unavailable === null,
    unavailableThrough: position.unavailable,
    gaps: gaps(),
    stopReason,
  };
}
