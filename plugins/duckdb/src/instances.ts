import type { DuckDBInstance } from "@duckdb/node-api";
import { loadDriver } from "./driver.js";

export interface InstanceKey {
  readonly path: string;
  readonly readOnlyFile: boolean;
  readonly downloadExtensions: boolean;
}

export interface PooledInstance {
  readonly instance: DuckDBInstance;
  /** Closes the instance, and with it the file lock, on the last release. */
  release(): void;
}

interface Entry {
  readonly opening: Promise<DuckDBInstance>;
  references: number;
}

/** DuckDB's own names for its settings (https://duckdb.org/docs/stable/configuration/overview). */
export function instanceOptions(key: InstanceKey): Record<string, string> {
  return {
    access_mode: key.readOnlyFile ? "READ_ONLY" : "READ_WRITE",
    autoinstall_known_extensions: String(key.downloadExtensions),
  };
}

/**
 * One instance per file, access mode and settings, shared by every session of this engine: DuckDB
 * refuses a second instance on a file with another configuration, and only one process may write
 * it. `DuckDBInstance.fromCache` was not used because it never closes, so the file
 * would stay locked after the last datasource on it disconnected.
 */
export class InstancePool {
  readonly #entries = new Map<string, Entry>();

  async acquire(key: InstanceKey): Promise<PooledInstance> {
    const id = JSON.stringify([key.path, key.readOnlyFile, key.downloadExtensions]);
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      const opening = loadDriver().then((driver) => driver.DuckDBInstance.create(key.path, instanceOptions(key)));
      entry = { opening, references: 0 };
      this.#entries.set(id, entry);
      opening.catch(() => {
        if (this.#entries.get(id) === entry) this.#entries.delete(id);
      });
    }
    entry.references += 1;
    const owned = entry;
    let instance: DuckDBInstance;
    try {
      instance = await owned.opening;
    } catch (cause) {
      owned.references -= 1;
      throw cause;
    }
    let released = false;
    return {
      instance,
      release: () => {
        if (released) return;
        released = true;
        owned.references -= 1;
        if (owned.references > 0) return;
        if (this.#entries.get(id) === owned) this.#entries.delete(id);
        instance.closeSync();
      },
    };
  }

  /** How many instances are open, for tests. */
  get size(): number {
    return this.#entries.size;
  }
}
