import { randomUUID } from "node:crypto";
import { z } from "@table-craft/plugin-api";
import type { EngineProcess } from "@table-craft/desktop/main/hosts.js";
import type { InvokeRegistrar } from "@table-craft/desktop/main/ipc.js";
import { OperationFileGrants, type FileOperation } from "@table-craft/desktop/main/operationGrants.js";
import { TransientCredentials } from "@table-craft/desktop/main/transientCredentials.js";
import { INVOKE_CHANNELS, type InvokeResult } from "@table-craft/desktop/preload/bridge.js";

const REQUEST = "table-craft:private-request";
const RESPONSE = "table-craft:private-response";
const OWNER_CLOSED = "table-craft:private-owner-closed";
const CHUNK_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING = 16;
const MAX_STREAMS = 4;
const FAILURE =
  "The private operation could not be confirmed. Check access and choose the file or enter the password again.";
const id = z.string().min(1).max(256);
const fileOperation = z.enum(["cluster.snapshot", "transfer.export", "transfer.import", "watch.export"]);
const chooseRequest = z.strictObject({ datasourceId: id, operation: fileOperation });
const secretRequest = z.strictObject({
  datasourceId: id,
  sessionId: id,
  user: z.string().min(1).max(1024),
  action: z.enum(["create", "password"]),
  password: z
    .string()
    .min(1)
    .max(16 * 1024),
});
const privateRequest = z.strictObject({ kind: z.literal(REQUEST), id, ownerId: id, op: id, payload: z.unknown() });
const streamRequest = z.strictObject({ streamId: id });
const readRequest = z.strictObject({ fileGrantId: id });
const publishRequest = z.strictObject({
  fileGrantId: id,
  operation: z.enum(["cluster.snapshot", "transfer.export", "watch.export"]),
  streamId: id,
  maxBytes: z.number().int().positive().max(MAX_FILE_BYTES),
});

interface Pending {
  readonly ownerId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Input {
  readonly iterator: AsyncIterator<Buffer>;
  readonly release: () => void;
  readonly closed: Promise<void>;
  busy: boolean;
  bytes: number;
}

interface Owner<Sender> {
  readonly engineId: string;
  readonly ownerId: string;
  readonly datasourceId: string;
  readonly sender: Sender;
  readonly readOnly: boolean;
  readonly peer: Peer;
  readonly abort: AbortController;
  readonly inputs: Map<string, Input>;
  readonly outputs: Map<string, AbortController>;
  active: boolean;
  requests: number;
  unsubscribe?: () => void;
}

interface Peer {
  readonly engineId: string;
  readonly process: EngineProcess;
  readonly pending: Map<string, Pending>;
}

export interface PrivateOperationOptions<Sender> {
  readonly choose: (sender: Sender, operation: FileOperation) => Promise<string | null>;
  readonly onSenderGone: (sender: Sender, dispose: () => void) => (() => void) | void;
}

/** Only sensitive file/credential traffic uses this parent channel; database calls stay on their port. */
export class PrivateOperations<Sender> {
  readonly #grants = new OperationFileGrants();
  readonly #credentials = new TransientCredentials();
  readonly #peers = new WeakMap<EngineProcess, Peer>();
  readonly #owners = new Map<string, Owner<Sender>>();
  readonly #options: PrivateOperationOptions<Sender>;

  constructor(options: PrivateOperationOptions<Sender>) {
    this.#options = options;
  }

  attach(process: EngineProcess, sender: Sender, datasourceId: string, readOnly: boolean): string {
    for (const owner of this.#owners.values())
      if (owner.sender === sender && owner.datasourceId === datasourceId) this.#dispose(owner);
    let peer = this.#peers.get(process);
    if (peer === undefined) {
      peer = { engineId: randomUUID(), process, pending: new Map() };
      this.#peers.set(process, peer);
      const bound = peer;
      process.on("message", (message) => this.#receive(bound, message));
      process.once("exit", () => {
        for (const owner of this.#owners.values()) if (owner.peer === bound) this.#dispose(owner, false);
        this.#grants.revokeEngine(bound.engineId);
        this.#credentials.revokeEngine(bound.engineId);
      });
    }
    const owner: Owner<Sender> = {
      engineId: peer.engineId,
      ownerId: randomUUID(),
      datasourceId,
      sender,
      readOnly,
      peer,
      abort: new AbortController(),
      inputs: new Map(),
      outputs: new Map(),
      active: true,
      requests: 0,
    };
    this.#owners.set(owner.ownerId, owner);
    const unsubscribe = this.#options.onSenderGone(sender, () => this.#dispose(owner));
    if (unsubscribe !== undefined) owner.unsubscribe = unsubscribe;
    return owner.ownerId;
  }

  revokeDatasource(datasourceId: string): void {
    for (const owner of this.#owners.values()) if (owner.datasourceId === datasourceId) this.#dispose(owner);
  }

  close(): void {
    for (const owner of this.#owners.values()) this.#dispose(owner);
  }

  register(ipc: InvokeRegistrar<Sender>): void {
    const handle = <Schema extends z.ZodType>(
      channel: string,
      schema: Schema,
      run: (sender: Sender, value: z.output<Schema>) => Promise<unknown>,
    ) => {
      ipc.handle(channel, async (event, payload): Promise<InvokeResult<unknown>> => {
        try {
          const parsed = schema.safeParse(payload);
          if (!parsed.success) throw new Error(FAILURE);
          return { ok: true, value: await run(event.sender, parsed.data) };
        } catch {
          return {
            ok: false,
            error: {
              message: FAILURE,
              hint: "Reconnect before trying again. Do not retry an uncertain change blindly.",
            },
          };
        }
      });
    };
    handle(INVOKE_CHANNELS.chooseOperationFile, chooseRequest, async (sender, request) => {
      const owner = this.#owner(sender, request.datasourceId);
      const grant = await this.#grants.choose(
        { engineId: owner.engineId, ownerId: owner.ownerId, operation: request.operation },
        () => this.#options.choose(sender, request.operation),
      );
      if (!owner.active) {
        this.#grants.revokeOwner(owner.engineId, owner.ownerId);
        throw new Error(FAILURE);
      }
      return grant;
    });
    handle(INVOKE_CHANNELS.applyAccessSecret, secretRequest, async (sender, request) => {
      const owner = this.#owner(sender, request.datasourceId);
      if (owner.readOnly || owner.requests >= MAX_PENDING) throw new Error(FAILURE);
      const authority = { engineId: owner.engineId, ownerId: owner.ownerId, operation: "access.secret.apply" as const };
      const credential = this.#credentials.issue(authority, request.password);
      request.password = "";
      owner.requests++;
      try {
        await this.#credentials.apply(credential, authority, (password) =>
          this.#call(owner, "secret.apply", {
            sessionId: request.sessionId,
            user: request.user,
            action: request.action,
            password,
          }).then(() => undefined),
        );
      } finally {
        owner.requests--;
      }
      return null;
    });
  }

  #owner(sender: Sender, datasourceId: string): Owner<Sender> {
    for (const owner of this.#owners.values())
      if (owner.sender === sender && owner.datasourceId === datasourceId && owner.active) return owner;
    throw new Error(FAILURE);
  }

  #dispose(owner: Owner<Sender>, notify = true): void {
    if (!owner.active) return;
    owner.active = false;
    owner.unsubscribe?.();
    owner.abort.abort();
    for (const input of owner.inputs.values()) input.release();
    for (const controller of owner.outputs.values()) controller.abort();
    this.#owners.delete(owner.ownerId);
    this.#grants.revokeOwner(owner.engineId, owner.ownerId);
    this.#credentials.revokeOwner(owner.engineId, owner.ownerId);
    for (const [requestId, pending] of owner.peer.pending) {
      if (pending.ownerId !== owner.ownerId) continue;
      clearTimeout(pending.timer);
      owner.peer.pending.delete(requestId);
      pending.reject();
    }
    if (notify) {
      try {
        owner.peer.process.postMessage({ kind: OWNER_CLOSED, ownerId: owner.ownerId });
      } catch {
        /* Already exited. */
      }
    }
  }

  #call(owner: Owner<Sender>, op: string, payload: unknown, signal = owner.abort.signal): Promise<unknown> {
    if (!owner.active || signal.aborted || owner.peer.pending.size >= MAX_PENDING)
      return Promise.reject(new Error(FAILURE));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        owner.peer.pending.delete(requestId);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new Error(FAILURE));
      };
      const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
      owner.peer.pending.set(requestId, {
        ownerId: owner.ownerId,
        timer,
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: abort,
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        owner.peer.process.postMessage({ kind: REQUEST, id: requestId, ownerId: owner.ownerId, op, payload });
      } catch {
        abort();
      }
    });
  }

  #receive(peer: Peer, message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.kind === RESPONSE && typeof record.id === "string") {
      const pending = peer.pending.get(record.id);
      if (pending === undefined) return;
      peer.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.ok === true) pending.resolve(record.value);
      else pending.reject();
      return;
    }
    if (record.kind === OWNER_CLOSED && typeof record.ownerId === "string") {
      const owner = this.#owners.get(record.ownerId);
      if (owner?.peer === peer) this.#dispose(owner, false);
      return;
    }
    const parsed = privateRequest.safeParse(message);
    if (!parsed.success) return;
    const request = parsed.data;
    const owner = this.#owners.get(request.ownerId);
    const reply = (ok: boolean, value?: unknown) => {
      try {
        peer.process.postMessage({ kind: RESPONSE, id: request.id, ok, ...(ok ? { value } : {}) });
      } catch {
        /* Already exited. */
      }
    };
    if (owner?.peer !== peer || !owner.active || owner.requests >= MAX_PENDING) {
      reply(false);
      return;
    }
    owner.requests++;
    void this.#file(owner, request.op, request.payload)
      .then(
        (value) => reply(true, value),
        () => reply(false),
      )
      .finally(() => {
        owner.requests--;
      });
  }

  async #file(owner: Owner<Sender>, op: string, payload: unknown): Promise<unknown> {
    if (op === "file.read.open") {
      const { fileGrantId } = readRequest.parse(payload);
      if (owner.readOnly || owner.inputs.size + owner.requests > MAX_STREAMS) throw new Error(FAILURE);
      const streamId = randomUUID();
      let ready!: (input: Input) => void;
      let failed!: (cause: unknown) => void;
      const opened = new Promise<Input>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const closed: Promise<void> = this.#grants.read(
        fileGrantId,
        { ...owner, operation: "transfer.import" },
        async (source) => {
          const iterator = source[Symbol.asyncIterator]();
          ready({ iterator, release, closed, busy: false, bytes: 0 });
          await held;
          await iterator.return?.();
        },
      );
      void closed.catch(failed);
      const input = await opened;
      if (!owner.active) {
        release();
        throw new Error(FAILURE);
      }
      owner.inputs.set(streamId, input);
      return { streamId };
    }
    if (op === "file.read.next" || op === "file.read.close") {
      const { streamId } = streamRequest.parse(payload);
      const input = owner.inputs.get(streamId);
      if (input === undefined) throw new Error(FAILURE);
      if (op === "file.read.close") {
        owner.inputs.delete(streamId);
        input.release();
        await input.closed;
        return null;
      }
      if (input.busy) throw new Error(FAILURE);
      input.busy = true;
      try {
        const next = await input.iterator.next();
        if (next.done) {
          owner.inputs.delete(streamId);
          input.release();
          await input.closed;
          return { done: true };
        }
        input.bytes += next.value.byteLength;
        if (
          next.value.byteLength > CHUNK_BYTES ||
          input.bytes > MAX_FILE_BYTES ||
          !owner.active ||
          !owner.inputs.has(streamId)
        )
          throw new Error(FAILURE);
        return { done: false, chunk: new Uint8Array(next.value) };
      } catch {
        owner.inputs.delete(streamId);
        input.release();
        throw new Error(FAILURE);
      } finally {
        input.busy = false;
      }
    }
    if (op === "file.cancel") {
      const { streamId } = streamRequest.parse(payload);
      owner.outputs.get(streamId)?.abort();
      return null;
    }
    if (op !== "file.publish") throw new Error(FAILURE);
    const request = publishRequest.parse(payload);
    if (owner.outputs.has(request.streamId) || owner.outputs.size >= MAX_STREAMS) throw new Error(FAILURE);
    const controller = new AbortController();
    owner.outputs.set(request.streamId, controller);
    const call = (op: string) => this.#call(owner, op, { streamId: request.streamId }, controller.signal);
    async function* source(): AsyncIterable<Uint8Array> {
      for (;;) {
        const next = await call("stream.next");
        if (typeof next !== "object" || next === null) throw new Error(FAILURE);
        const part = next as { done?: unknown; clean?: unknown; chunk?: unknown };
        if (part.done === true && part.clean === true) return;
        if (
          part.done !== false ||
          !(part.chunk instanceof Uint8Array) ||
          part.chunk.byteLength === 0 ||
          part.chunk.byteLength > CHUNK_BYTES
        )
          throw new Error(FAILURE);
        yield part.chunk;
      }
    }
    try {
      return await this.#grants.publish(
        request.fileGrantId,
        { ...owner, operation: request.operation },
        source(),
        request.maxBytes,
        controller.signal,
      );
    } finally {
      owner.outputs.delete(request.streamId);
      if (owner.active) void this.#call(owner, "stream.cancel", { streamId: request.streamId }).catch(() => undefined);
    }
  }
}
