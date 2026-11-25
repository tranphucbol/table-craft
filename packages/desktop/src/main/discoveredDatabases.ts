import { createHash } from "node:crypto";

export interface DiscoveredDatabase {
  readonly sourceId: string;
  readonly database: string;
  readonly field: string;
}

/** Session-only database siblings and the full picker cache, kept out of datasource persistence. */
export class DiscoveredDatabases {
  readonly entries = new Map<string, DiscoveredDatabase>();
  readonly names = new Map<string, readonly string[]>();

  constructor(
    private readonly stop: (id: string) => Promise<void>,
    private readonly cleanFiles: (id: string) => Promise<void>,
  ) {}

  id(sourceId: string, database: string): string {
    const digest = createHash("sha256").update(database, "utf8").digest("hex").slice(0, 32);
    return `${sourceId}~db~${digest}`;
  }

  async synchronize(
    sourceId: string,
    names: readonly string[],
    selected: ReadonlySet<string>,
    field: string,
    invalidName: () => Error,
  ): Promise<readonly string[]> {
    for (const database of names) {
      if (database.length === 0 || database.includes("\0")) throw invalidName();
    }
    const uniqueNames = [...new Set(names)];
    this.names.set(sourceId, uniqueNames);
    for (const [id, target] of [...this.entries]) {
      if (target.sourceId !== sourceId) continue;
      if (!uniqueNames.includes(target.database)) await this.discard(id, true);
      else if (!selected.has(target.database)) await this.discard(id, false);
    }
    const added: string[] = [];
    for (const database of uniqueNames) {
      if (!selected.has(database)) continue;
      const id = this.id(sourceId, database);
      this.entries.set(id, { sourceId, database, field });
      added.push(id);
    }
    return added;
  }

  async discard(id: string, removeFiles: boolean): Promise<void> {
    await this.stop(id);
    this.entries.delete(id);
    if (removeFiles) await this.cleanFiles(id);
  }

  async discardSource(sourceId: string): Promise<void> {
    for (const [id, target] of [...this.entries]) {
      if (target.sourceId === sourceId) await this.discard(id, true);
    }
  }

  async disconnectSource(sourceId: string): Promise<void> {
    for (const [id, target] of this.entries) if (target.sourceId === sourceId) await this.stop(id);
  }
}
