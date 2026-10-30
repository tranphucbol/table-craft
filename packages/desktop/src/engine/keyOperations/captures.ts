import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineOperationFiles } from "./files.js";
import { type KeyOperationScope, invalidOperation } from "./scope.js";
import { TRANSFER_MAX_FILE_BYTES } from "./transferFormat.js";

const MAX_CAPTURES = 4;
const MAX_CHUNK_BYTES = 16_777_216;
export interface KeyCapture {
  readonly path: string;
  readonly digest: string;
  readonly bytes: string;
  readonly directory: string;
}

export class KeyCaptures {
  private readonly captures = new Map<string, Promise<KeyCapture>>();
  private readonly directories = new Set<string>();
  constructor(
    private readonly scope: KeyOperationScope,
    private readonly files: EngineOperationFiles | undefined,
  ) {
    scope.register(() => this.close());
  }

  capture(id: string): Promise<KeyCapture> {
    this.scope.capability("bulkTransfer");
    const cached = this.captures.get(id);
    if (cached !== undefined) return cached;
    if (this.files === undefined) throw invalidOperation("The host has not installed authorized file operations.");
    if (this.captures.size >= MAX_CAPTURES)
      throw invalidOperation(
        "This connection has reached its retained import budget; reconnect to release old imports.",
      );
    const opening = this.files
      .read(id, async (source) => {
        const directory = await mkdtemp(join(tmpdir(), "tablecraft-key-import-"));
        this.directories.add(directory);
        const path = join(directory, "capture.json");
        const file = await open(path, "wx", 0o600);
        const digest = createHash("sha256");
        let bytes = 0;
        try {
          for await (const chunk of source) {
            this.scope.live();
            bytes += chunk.byteLength;
            if (bytes > TRANSFER_MAX_FILE_BYTES || chunk.byteLength > MAX_CHUNK_BYTES)
              throw invalidOperation("Import exceeds its captured file budget.");
            digest.update(chunk);
            await file.writeFile(chunk);
          }
          this.scope.live();
          await file.sync();
          return { path, digest: digest.digest("hex"), bytes: String(bytes), directory };
        } catch (cause) {
          await rm(directory, { recursive: true, force: true });
          this.directories.delete(directory);
          throw cause;
        } finally {
          await file.close();
        }
      })
      .catch((cause: unknown) => {
        this.captures.delete(id);
        throw cause;
      });
    this.captures.set(id, opening);
    return opening;
  }

  async verify(capture: KeyCapture): Promise<void> {
    this.scope.live();
    const hash = createHash("sha256");
    let bytes = 0n;
    for await (const chunk of createReadStream(capture.path) as AsyncIterable<Buffer>) {
      this.scope.live();
      hash.update(chunk);
      bytes += BigInt(chunk.length);
      if (bytes > BigInt(TRANSFER_MAX_FILE_BYTES)) throw invalidOperation("Captured import exceeds its budget.");
    }
    if (hash.digest("hex") !== capture.digest || String(bytes) !== capture.bytes)
      throw invalidOperation("The captured import changed; select and preview it again.");
  }

  async close(): Promise<void> {
    const directories = [...this.directories];
    this.directories.clear();
    this.captures.clear();
    await Promise.allSettled(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
}
