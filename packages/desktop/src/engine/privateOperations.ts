import { randomUUID } from "node:crypto";
import { z } from "@table-craft/plugin-api";
import type { EngineConnection } from "./engine.js";
import type { EngineOperationFiles } from "./keyOperations/files.js";
import { invalidOperation } from "./keyOperations/scope.js";

const REQUEST = "table-craft:private-request";
const RESPONSE = "table-craft:private-response";
const OWNER_CLOSED = "table-craft:private-owner-closed";
const PRIVATE_TIMEOUT_MS = 30_000;
const PRIVATE_CHUNK_BYTES = 65_536;
const MAX_SOURCE_CHUNK_BYTES = 16_777_216;
const MAX_PENDING = 128;
const id = z.string().min(1).max(256);
const requestSchema = z.strictObject({
  kind: z.literal(REQUEST),
  id,
  ownerId: id,
  op: z.string(),
  payload: z.unknown(),
});
const streamPayload = z.strictObject({ streamId: id });
const secretPayload = z.strictObject({
  sessionId: id,
  user: z.string().min(1).max(1_024),
  action: z.enum(["create", "password"]),
  password: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= 16_384),
});
interface Pending {
  readonly ownerId: string;
  resolve(value: unknown): void;
  reject(): void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface Stream {
  readonly ownerId: string;
  readonly iterator: AsyncIterator<Uint8Array>;
  readonly cancel: (() => Promise<void>) | undefined;
  readonly signal: AbortSignal;
  remainder: Uint8Array | null;
  busy: boolean;
  closed: boolean;
  clean: boolean;
}

/** This object sees only the trusted utilityProcess parent port, never a renderer port. */
export class EnginePrivateOperations {
  private readonly owners = new Map<string, Promise<EngineConnection>>();
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, Stream>();
  constructor(
    private readonly send: (message: unknown) => void,
    private readonly ownerClosed?: (ownerId: string) => void,
  ) {}

  bind(ownerId: string, connection: Promise<EngineConnection>): void {
    if (this.owners.has(ownerId)) throw invalidOperation("Duplicate private-operation owner.");
    this.owners.set(ownerId, connection);
  }

  private call(ownerId: string, op: string, payload: unknown): Promise<unknown> {
    if (!this.owners.has(ownerId) || this.pending.size >= MAX_PENDING)
      return Promise.reject(invalidOperation("Private operation is unavailable."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = () => {
        this.pending.delete(requestId);
        reject(invalidOperation("Private operation could not be confirmed."));
      };
      const timer = setTimeout(fail, PRIVATE_TIMEOUT_MS);
      this.pending.set(requestId, { ownerId, resolve, reject: fail, timer });
      try {
        this.send({ kind: REQUEST, id: requestId, ownerId, op, payload });
      } catch {
        clearTimeout(timer);
        fail();
      }
    });
  }

  files(ownerId: string): EngineOperationFiles {
    return {
      read: async (fileGrantId, use) => {
        const opened = z
          .strictObject({ streamId: id })
          .parse(await this.call(ownerId, "file.read.open", { fileGrantId }));
        const next = () => this.call(ownerId, "file.read.next", opened);
        async function* source() {
          while (true) {
            const result = z
              .discriminatedUnion("done", [
                z.strictObject({ done: z.literal(true) }),
                z.strictObject({
                  done: z.literal(false),
                  chunk: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= PRIVATE_CHUNK_BYTES),
                }),
              ])
              .parse(await next());
            if (result.done) return;
            yield result.chunk;
          }
        }
        try {
          return await use(source());
        } finally {
          await this.call(ownerId, "file.read.close", opened).catch(() => undefined);
        }
      },
      publish: async (fileGrantId, operation, source, maxBytes, signal, onCancel) => {
        const streamId = randomUUID();
        const stream: Stream = {
          ownerId,
          iterator: source[Symbol.asyncIterator](),
          signal,
          cancel: onCancel,
          remainder: null,
          busy: false,
          closed: false,
          clean: false,
        };
        this.streams.set(streamId, stream);
        const abort = () => {
          void this.cancelStream(streamId);
          void this.call(ownerId, "file.cancel", { streamId }).catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) throw invalidOperation("Publication cancelled.");
          await this.call(ownerId, "file.publish", { fileGrantId, operation, streamId, maxBytes });
          if (!stream.clean || signal.aborted)
            throw invalidOperation("The host did not consume a clean complete stream.");
        } finally {
          signal.removeEventListener("abort", abort);
          await this.cancelStream(streamId);
        }
      },
    };
  }

  private async nextStream(ownerId: string, streamId: string): Promise<unknown> {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.ownerId !== ownerId || stream.busy || stream.closed || stream.signal.aborted)
      throw invalidOperation("Private stream is unavailable.");
    stream.busy = true;
    try {
      let chunk = stream.remainder;
      if (chunk === null) {
        const result = await stream.iterator.next();
        if (stream.signal.aborted || !this.owners.has(ownerId)) throw invalidOperation("Private stream cancelled.");
        if (result.done === true) {
          stream.closed = true;
          stream.clean = true;
          return { done: true, clean: true };
        }
        chunk = result.value;
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_SOURCE_CHUNK_BYTES)
          throw invalidOperation("Private stream chunk exceeds its budget.");
      }
      stream.remainder = chunk.byteLength > PRIVATE_CHUNK_BYTES ? chunk.subarray(PRIVATE_CHUNK_BYTES) : null;
      return { done: false, chunk: Uint8Array.from(chunk.subarray(0, PRIVATE_CHUNK_BYTES)) };
    } finally {
      stream.busy = false;
    }
  }

  private async cancelStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    this.streams.delete(streamId);
    if (!stream.closed) await stream.cancel?.().catch(() => undefined);
    stream.closed = true;
    void stream.iterator.return?.().catch(() => undefined);
  }

  async receive(message: unknown): Promise<boolean> {
    const envelope = message as {
      kind?: unknown;
      id?: unknown;
      ok?: unknown;
      value?: unknown;
      ownerId?: unknown;
    } | null;
    if (envelope?.kind === RESPONSE && typeof envelope.id === "string") {
      const pending = this.pending.get(envelope.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(envelope.id);
        if (envelope.ok === true) pending.resolve(envelope.value);
        else pending.reject();
      }
      return true;
    }
    if (envelope?.kind === OWNER_CLOSED && typeof envelope.ownerId === "string") {
      await this.closeOwner(envelope.ownerId, false);
      return true;
    }
    if (envelope?.kind !== REQUEST) return false;
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) return true;
    const request = parsed.data;
    let password: Uint8Array | undefined;
    try {
      const connection = this.owners.get(request.ownerId);
      if (connection === undefined) throw invalidOperation("Private-operation owner is closed.");
      let value: unknown = null;
      if (request.op === "stream.next")
        value = await this.nextStream(request.ownerId, streamPayload.parse(request.payload).streamId);
      else if (request.op === "stream.cancel") {
        const { streamId } = streamPayload.parse(request.payload);
        if (this.streams.get(streamId)?.ownerId !== request.ownerId)
          throw invalidOperation("Private stream owner does not match.");
        await this.cancelStream(streamId);
      } else if (request.op === "secret.apply") {
        const input = request.payload as { password?: unknown } | null;
        if (input?.password instanceof Uint8Array) password = input.password;
        const secret = secretPayload.parse(request.payload);
        password = secret.password;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(password);
        await (
          await connection
        ).applyAccessSecret(
          { kind: secret.action === "create" ? "createUser" : "changePassword", user: secret.user, password: text },
          secret.sessionId,
        );
      } else throw invalidOperation("Unknown private operation.");
      this.send({ kind: RESPONSE, id: request.id, ok: true, value });
    } catch {
      this.send({ kind: RESPONSE, id: request.id, ok: false });
    } finally {
      password?.fill(0);
    }
    return true;
  }

  async closeOwner(ownerId: string, notify = true): Promise<void> {
    const connection = this.owners.get(ownerId);
    this.owners.delete(ownerId);
    this.ownerClosed?.(ownerId);
    for (const pending of this.pending.values())
      if (pending.ownerId === ownerId) {
        clearTimeout(pending.timer);
        pending.reject();
      }
    await Promise.allSettled(
      [...this.streams]
        .filter(([, stream]) => stream.ownerId === ownerId)
        .map(([streamId]) => this.cancelStream(streamId)),
    );
    await connection?.then((open) => open.close()).catch(() => undefined);
    if (notify) this.send({ kind: OWNER_CLOSED, ownerId });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.owners.keys()].map((ownerId) => this.closeOwner(ownerId)));
  }
}
