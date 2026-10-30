import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath, mkdtemp, open, link, unlink, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const GRANT_TTL_MS = 5 * 60 * 1000;
const CHECKSUM_BYTES = 32;
const SNAPSHOT_PAGE_BYTES = 512;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;

export type FileOperation = "cluster.snapshot" | "transfer.export" | "transfer.import" | "watch.export";

export interface OperationOwner {
  readonly engineId: string;
  readonly ownerId: string;
  readonly operation: FileOperation;
}

interface Grant extends OperationOwner {
  readonly path: string;
  readonly parent: string;
  readonly expires: number;
  readonly inputIdentity?: { readonly dev: number; readonly ino: number };
}

function denied(): Error {
  return new Error("The file authorization expired or does not belong to this operation. Choose the file again.");
}

/** Main-only authority. The chooser must be a native OS dialog scoped to the requesting window. */
export class OperationFileGrants {
  readonly #grants = new Map<string, Grant>();

  async choose(owner: OperationOwner, chooser: () => Promise<string | null>): Promise<string | null> {
    for (const [id, grant] of this.#grants) if (grant.expires <= Date.now()) this.#grants.delete(id);
    const selected = await chooser();
    if (selected === null) return null;
    const selectedPath = resolve(selected);
    const parent = await realpath(dirname(selectedPath));
    const path = join(parent, basename(selectedPath));
    let inputIdentity: { dev: number; ino: number } | undefined;
    if (owner.operation === "transfer.import") {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Choose a regular file, not a symbolic link.");
      inputIdentity = { dev: info.dev, ino: info.ino };
    } else {
      await lstat(path).then(
        () => {
          throw new Error("The destination already exists. Choose a new filename.");
        },
        (cause: NodeJS.ErrnoException) => {
          if (cause.code !== "ENOENT") throw cause;
        },
      );
    }
    const id = randomUUID();
    this.#grants.set(id, {
      ...owner,
      path,
      parent,
      expires: Date.now() + GRANT_TTL_MS,
      ...(inputIdentity === undefined ? {} : { inputIdentity }),
    });
    return id;
  }

  revokeEngine(engineId: string): void {
    for (const [id, grant] of this.#grants) if (grant.engineId === engineId) this.#grants.delete(id);
  }

  revokeOwner(engineId: string, ownerId: string): void {
    for (const [id, grant] of this.#grants)
      if (grant.engineId === engineId && grant.ownerId === ownerId) this.#grants.delete(id);
  }

  #consume(id: string, owner: OperationOwner): Grant {
    const grant = this.#grants.get(id);
    if (
      grant === undefined ||
      grant.expires < Date.now() ||
      grant.engineId !== owner.engineId ||
      grant.ownerId !== owner.ownerId ||
      grant.operation !== owner.operation
    )
      throw denied();
    this.#grants.delete(id);
    return grant;
  }

  async read<T>(id: string, owner: OperationOwner, use: (file: AsyncIterable<Buffer>) => Promise<T>): Promise<T> {
    if (owner.operation !== "transfer.import") throw denied();
    const grant = this.#consume(id, owner);
    if ((await realpath(dirname(grant.path))) !== grant.parent) throw denied();
    const file = await open(grant.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      const identity = grant.inputIdentity;
      if (!info.isFile() || identity === undefined || info.dev !== identity.dev || info.ino !== identity.ino)
        throw denied();
      return await use(file.createReadStream({ autoClose: false, highWaterMark: READ_CHUNK_BYTES }));
    } finally {
      await file.close();
    }
  }

  /** Source completion must mean clean end AND successful transport status, not just stream EOF. */
  async publish(
    id: string,
    owner: OperationOwner,
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: number }> {
    if (owner.operation === "transfer.import" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw denied();
    const grant = this.#consume(id, owner);
    if ((await realpath(dirname(grant.path))) !== grant.parent) throw denied();
    const directory = await mkdtemp(join(grant.parent, ".tablecraft-"));
    const path = join(directory, basename(grant.path));
    let bytes = 0;
    let tail: Buffer = Buffer.alloc(0);
    const hash = createHash("sha256");
    try {
      signal?.throwIfAborted();
      const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directoryHandle.chmod(PRIVATE_DIRECTORY_MODE);
      } finally {
        await directoryHandle.close();
      }
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      try {
        for await (const part of source) {
          signal?.throwIfAborted();
          bytes += part.byteLength;
          if (bytes > maxBytes) throw new Error("The export exceeds the authorized size limit.");
          const chunk = Buffer.from(part);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await file.write(chunk, offset, chunk.length - offset);
            if (written.bytesWritten === 0) throw new Error("The export could not be written.");
            offset += written.bytesWritten;
          }
          if (owner.operation === "cluster.snapshot") {
            const combined = Buffer.concat([tail, chunk]);
            const boundary = Math.max(0, combined.length - CHECKSUM_BYTES);
            hash.update(combined.subarray(0, boundary));
            tail = Buffer.from(combined.subarray(boundary));
          }
        }
        if (
          owner.operation === "cluster.snapshot" &&
          (bytes <= CHECKSUM_BYTES ||
            bytes % SNAPSHOT_PAGE_BYTES !== CHECKSUM_BYTES ||
            tail.length !== CHECKSUM_BYTES ||
            !timingSafeEqual(hash.digest(), tail))
        ) {
          throw new Error("The snapshot is incomplete or its SHA-256 checksum does not match. Nothing was published.");
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await realpath(dirname(grant.path))) !== grant.parent) throw denied();
      signal?.throwIfAborted();
      // A hard link publishes atomically without ever replacing a concurrently created destination.
      await link(path, grant.path);
      await unlink(path);
      return { bytes };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
