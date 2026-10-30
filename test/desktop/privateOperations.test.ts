import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateOperations } from "@table-craft/desktop/main/privateOperations.js";
import { INVOKE_CHANNELS, type InvokeResult } from "@table-craft/desktop/preload/bridge.js";

const REQUEST = "table-craft:private-request";
const RESPONSE = "table-craft:private-response";
const roots: string[] = [];
const adapters: PrivateOperations<string>[] = [];

class Process extends EventEmitter {
  readonly sent: unknown[] = [];
  respond: (message: Record<string, unknown>) => void = () => undefined;
  postMessage(message: unknown): void {
    this.sent.push(message);
    this.respond(message as Record<string, unknown>);
  }
  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }
}

async function fixture(readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "tablecraft-private-"));
  roots.push(root);
  let selected: string | null = join(root, "output");
  const gone = new Map<string, () => void>();
  const operations = new PrivateOperations<string>({
    choose: () => Promise.resolve(selected),
    onSenderGone: (sender, dispose) => {
      gone.set(sender, dispose);
    },
  });
  adapters.push(operations);
  const handlers = new Map<string, (event: { sender: string }, ...args: unknown[]) => unknown>();
  operations.register({
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
  });
  const process = new Process();
  const ownerId = operations.attach(process, "window", "db", readOnly);
  let sequence = 0;
  async function request(op: string, payload: unknown, owner = ownerId): Promise<Record<string, unknown>> {
    const id = `request-${String(++sequence)}`;
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      const previous = process.respond;
      process.respond = (message) => {
        previous(message);
        if (message.kind === RESPONSE && message.id === id) resolve(message);
      };
    });
    process.emit("message", { kind: REQUEST, id, ownerId: owner, op, payload });
    return answer;
  }
  const invoke = async <T>(channel: string, payload: unknown, sender = "window") =>
    (await handlers.get(channel)!({ sender }, payload)) as InvokeResult<T>;
  const choose = (operation = "transfer.export") =>
    invoke<string | null>(INVOKE_CHANNELS.chooseOperationFile, { datasourceId: "db", operation });
  return {
    root,
    process,
    ownerId,
    operations,
    gone,
    invoke,
    choose,
    request,
    select: (path: string | null) => {
      selected = path;
    },
  };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.close();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("private host operations", () => {
  it("givenRendererAuthorityAttempts_whenChoosing_thenOnlyAuthenticatedOwnerAndExactSchemaAccepted", async () => {
    const f = await fixture();
    expect(
      await f.invoke(INVOKE_CHANNELS.chooseOperationFile, {
        datasourceId: "db",
        operation: "transfer.export",
        path: "/arbitrary",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await f.invoke(
        INVOKE_CHANNELS.chooseOperationFile,
        {
          datasourceId: "db",
          operation: "transfer.export",
        },
        "other-window",
      ),
    ).toMatchObject({ ok: false });
    const grant = await f.choose();
    expect(grant.ok).toBe(true);
    expect(JSON.stringify(grant)).not.toContain(f.root);
    f.select(null);
    expect(await f.choose()).toEqual({ ok: true, value: null });
  });

  it("givenSnapshot_whenCleanStatusConfirmed_thenChecksummedFilePublishedWithoutRendererPath", async () => {
    const f = await fixture();
    const grant = await f.choose("cluster.snapshot");
    if (!grant.ok) throw new Error("grant missing");
    const page = Buffer.alloc(512, 7);
    const bytes = Buffer.concat([page, createHash("sha256").update(page).digest()]);
    let pull = 0;
    f.process.respond = (message) => {
      if (message.kind !== REQUEST) return;
      const value =
        message.op === "stream.next"
          ? ++pull === 1
            ? { done: false, chunk: bytes }
            : { done: true, clean: true }
          : null;
      queueMicrotask(() => f.process.emit("message", { kind: RESPONSE, id: message.id, ok: true, value }));
    };
    expect(
      await f.request("file.publish", {
        fileGrantId: grant.value,
        operation: "cluster.snapshot",
        streamId: "snapshot",
        maxBytes: 4096,
      }),
    ).toMatchObject({ ok: true, value: { bytes: bytes.length } });
    expect(await readFile(join(f.root, "output"))).toEqual(bytes);
    expect(pull).toBe(2);
  });

  it("givenEOFWithoutSuccessfulStatus_whenPublishing_thenNoDestinationAndNoPrivateRemainder", async () => {
    const f = await fixture();
    const grant = await f.choose();
    if (!grant.ok) throw new Error("grant missing");
    f.process.respond = (message) => {
      if (message.kind !== REQUEST) return;
      queueMicrotask(() =>
        f.process.emit("message", {
          kind: RESPONSE,
          id: message.id,
          ok: true,
          value: { done: true, clean: false },
        }),
      );
    };
    expect(
      await f.request("file.publish", {
        fileGrantId: grant.value,
        operation: "transfer.export",
        streamId: "export",
        maxBytes: 4096,
      }),
    ).toMatchObject({ ok: false });
    expect(await readdir(f.root)).toEqual([]);
  });

  it("givenImport_whenRead_thenOnlyBoundGrantAndBoundedChunksAndExplicitClose", async () => {
    const f = await fixture();
    const path = join(f.root, "input");
    await writeFile(path, Buffer.alloc(128 * 1024, 3));
    f.select(path);
    const grant = await f.choose("transfer.import");
    if (!grant.ok) throw new Error("grant missing");
    const otherOwner = f.operations.attach(f.process, "other-window", "db", false);
    expect(await f.request("file.read.open", { fileGrantId: grant.value }, otherOwner)).toMatchObject({ ok: false });
    const opened = await f.request("file.read.open", { fileGrantId: grant.value });
    expect(opened.ok).toBe(true);
    const { streamId } = opened.value as { streamId: string };
    const chunk = await f.request("file.read.next", { streamId });
    expect((chunk.value as { chunk: Uint8Array }).chunk.length).toBeLessThanOrEqual(64 * 1024);
    expect(await f.request("file.read.close", { streamId })).toMatchObject({ ok: true });
    expect(await f.request("file.read.next", { streamId })).toMatchObject({ ok: false });
  });

  it("givenPendingExport_whenCancelled_thenPullAbortedAndPrivateFileRemoved", async () => {
    const f = await fixture();
    const grant = await f.choose();
    if (!grant.ok) throw new Error("grant missing");
    let pulled!: () => void;
    const pulling = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    f.process.respond = (message) => {
      if (message.kind !== REQUEST) return;
      if (message.op === "stream.next") pulled();
      else queueMicrotask(() => f.process.emit("message", { kind: RESPONSE, id: message.id, ok: true, value: null }));
    };
    const publishing = f.request("file.publish", {
      fileGrantId: grant.value,
      operation: "transfer.export",
      streamId: "cancelled",
      maxBytes: 4096,
    });
    await pulling;
    expect(await f.request("file.cancel", { streamId: "cancelled" })).toMatchObject({ ok: true });
    expect(await publishing).toMatchObject({ ok: false });
    expect(await readdir(f.root)).toEqual([]);
    expect(f.process.sent).toContainEqual(expect.objectContaining({ op: "stream.cancel" }));
  });

  it("givenWriteOnlyPassword_whenDriverFails_thenFixedFailureNoSecretAndBuffersErased", async () => {
    const f = await fixture();
    let delivered: Uint8Array | undefined;
    f.process.respond = (message) => {
      if (message.kind !== REQUEST || message.op !== "secret.apply") return;
      expect(message.ownerId).toBe(f.ownerId);
      expect(message.payload).toMatchObject({ sessionId: "session", user: "alice", action: "password" });
      delivered = (message.payload as { password: Uint8Array }).password;
      queueMicrotask(() =>
        f.process.emit("message", {
          kind: RESPONSE,
          id: message.id,
          ok: false,
          error: "request password=private-password",
        }),
      );
    };
    const result = await f.invoke(INVOKE_CHANNELS.applyAccessSecret, {
      datasourceId: "db",
      sessionId: "session",
      user: "alice",
      action: "password",
      password: "private-password",
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private-password");
    expect(delivered?.every((byte) => byte === 0)).toBe(true);
  });

  it("givenMissingConsoleSession_whenPasswordSubmitted_thenRejectedBeforePrivateDelivery", async () => {
    const f = await fixture();
    expect(
      await f.invoke(INVOKE_CHANNELS.applyAccessSecret, {
        datasourceId: "db",
        user: "alice",
        action: "password",
        password: "private",
      }),
    ).toMatchObject({ ok: false });
    expect(f.process.sent).toEqual([]);
  });

  it("givenReadonlyOrDestroyedOwner_whenSecretSubmitted_thenNeverForwarded", async () => {
    const f = await fixture(true);
    const request = { datasourceId: "db", sessionId: "session", user: "alice", action: "create", password: "private" };
    expect(await f.invoke(INVOKE_CHANNELS.applyAccessSecret, request)).toMatchObject({ ok: false });
    expect(f.process.sent).toEqual([]);
    f.gone.get("window")!();
    expect(await f.choose()).toMatchObject({ ok: false });
    expect(f.process.sent).toContainEqual({ kind: "table-craft:private-owner-closed", ownerId: f.ownerId });
  });
});
