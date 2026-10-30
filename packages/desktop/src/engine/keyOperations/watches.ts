import type { KeyWatch, KeyWatchEvent, KeyWatchRequest, Session } from "@table-craft/plugin-api";
import type { KeyWatchSummary, KeyWatchWindow, RequestOf } from "@table-craft/desktop/engine/protocol.js";
import {
  KEY_ADVANCED_MAX_BYTES,
  KEY_ADVANCED_MAX_COUNT,
  KEY_ADVANCED_MAX_TIMEOUT_MS,
  KEY_WATCH_MAX_EVENTS,
  KEY_WATCH_MAX_RING_BYTES,
} from "@table-craft/desktop/engine/protocol.js";
import { type KeyOperationScope, KEY_RESOURCE_LIMIT, invalidOperation, quietClose, requireMethod } from "./scope.js";
import { captureRetainedWatch } from "./watchExport.js";

interface HeldEvent {
  readonly sequence: string;
  readonly event: KeyWatchEvent;
  readonly bytes: number;
}

/** Retention loss is independent from the plugin's transport/revision gap. */
export class KeyWatchRing {
  private rows: HeldEvent[] = [];
  private head = 0;
  private bytes = 0;
  private next = 1n;
  private evicted = 0n;

  constructor(
    readonly maxEvents: number,
    readonly maxBytes: number,
  ) {}

  append(event: KeyWatchEvent): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.maxBytes) return false;
    this.rows.push({ sequence: String(this.next++), event, bytes });
    this.bytes += bytes;
    while (this.rows.length - this.head > this.maxEvents || this.bytes > this.maxBytes) {
      const oldest = this.rows[this.head++];
      if (oldest !== undefined) this.bytes -= oldest.bytes;
      this.evicted += 1n;
    }
    if (this.head > this.maxEvents) {
      this.rows = this.rows.slice(this.head);
      this.head = 0;
    }
    return true;
  }

  clear(): void {
    this.evicted += BigInt(this.rows.length - this.head);
    this.rows = [];
    this.head = 0;
    this.bytes = 0;
  }

  window(after: string | null, count: number, maxBytes: number) {
    const rows: { readonly sequence: string; readonly event: KeyWatchEvent }[] = [];
    let bytes = 0;
    for (let index = this.head; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (row === undefined || (after !== null && BigInt(row.sequence) <= BigInt(after))) continue;
      if (rows.length >= count || bytes + row.bytes > maxBytes) break;
      rows.push({ sequence: row.sequence, event: row.event });
      bytes += row.bytes;
    }
    return {
      rows,
      oldestSequence: this.rows[this.head]?.sequence ?? null,
      newestSequence: this.rows.at(-1)?.sequence ?? null,
      evictedEvents: String(this.evicted),
    };
  }

  evictions(): string {
    return String(this.evicted);
  }
}

interface RunningWatch {
  readonly id: string;
  readonly request: KeyWatchRequest;
  readonly ring: KeyWatchRing;
  readonly session: Session;
  readonly watch: KeyWatch;
  state: KeyWatchSummary["state"];
  completedRevision: string | null;
  gap: KeyWatchSummary["gap"];
  closed: boolean;
  closing: Promise<void> | null;
}

export class KeyWatches {
  private readonly watches = new Map<string, RunningWatch>();

  constructor(private readonly scope: KeyOperationScope) {
    scope.register(() => this.close());
  }

  private summary(open: RunningWatch): KeyWatchSummary {
    return {
      watchId: open.id,
      request: open.request,
      state: open.state,
      completedRevision: open.completedRevision,
      gap: open.gap,
      evictedEvents: open.ring.evictions(),
    };
  }

  private find(id: string): RunningWatch {
    this.scope.capability("watch");
    const open = this.watches.get(id);
    if (open === undefined) throw invalidOperation("No watch with this ID belongs to this connection.");
    return open;
  }

  async start(request: RequestOf<"watch.start">): Promise<KeyWatchSummary> {
    this.scope.capability("watch");
    if (this.watches.size >= KEY_RESOURCE_LIMIT) {
      const stopped = [...this.watches.values()].find((entry) => entry.closed);
      if (stopped === undefined) throw invalidOperation("Too many watches; stop a watch first.");
      this.watches.delete(stopped.id);
    }
    const session = await this.scope.open("watch");
    let watch: KeyWatch | undefined;
    try {
      const watcher = session.watch;
      const spec: KeyWatchRequest = { database: request.database, range: request.range, from: request.from };
      watch = await requireMethod(watcher, "open", "watch.open").open(spec);
      this.scope.live();
      requireMethod(watch, "next", "watch.next");
      requireMethod(watch, "close", "watch.close");
      const held: RunningWatch = {
        id: this.scope.id(),
        request: spec,
        ring: new KeyWatchRing(request.maxEvents, request.maxBytes),
        session,
        watch,
        state: "live",
        completedRevision: null,
        gap: null,
        closed: false,
        closing: null,
      };
      this.watches.set(held.id, held);
      void this.pull(held);
      return this.summary(held);
    } catch (cause) {
      if (watch !== undefined) await quietClose(watch);
      await this.scope.release(session);
      throw cause;
    }
  }

  private async pull(open: RunningWatch): Promise<void> {
    try {
      while (!open.closed) {
        const batch = await open.watch.next({
          count: KEY_ADVANCED_MAX_COUNT,
          maxBytes: KEY_ADVANCED_MAX_BYTES,
          timeoutMs: KEY_ADVANCED_MAX_TIMEOUT_MS,
        });
        if (open.closed) break;
        this.scope.live();
        if (batch.events.length > KEY_ADVANCED_MAX_COUNT)
          throw invalidOperation("The watch exceeded its event budget.");
        for (const event of batch.events) {
          if (Buffer.byteLength(JSON.stringify(event)) > KEY_ADVANCED_MAX_BYTES || !open.ring.append(event)) {
            open.gap = {
              reason: "eventTooLarge",
              fromRevision: event.revision.modRevision,
              toRevision: event.revision.modRevision,
            };
            open.state = "gap";
            return;
          }
        }
        open.state = batch.state;
        open.gap = batch.gap;
        if (batch.completedRevision !== null) {
          if (open.completedRevision !== null && BigInt(batch.completedRevision) < BigInt(open.completedRevision))
            throw invalidOperation("The watch checkpoint moved backwards.");
          open.completedRevision = batch.completedRevision;
        }
        if (batch.state === "gap" || batch.state === "stopped") break;
        if (batch.events.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    } catch {
      if (open.state !== "gap") open.state = "stopped";
    } finally {
      await this.stopOpen(open);
    }
  }

  private stopOpen(open: RunningWatch): Promise<void> {
    if (open.closing !== null) return open.closing;
    open.closed = true;
    if (open.state !== "gap") open.state = "stopped";
    open.closing = quietClose(open.watch).then(() => this.scope.release(open.session));
    return open.closing;
  }

  window(request: RequestOf<"watch.window">): KeyWatchWindow {
    const open = this.find(request.watchId);
    return {
      watchId: open.id,
      ...open.ring.window(request.afterSequence, request.count, request.maxBytes),
      state: open.state,
      completedRevision: open.completedRevision,
      gap: open.gap,
    };
  }

  capture(id: string, maxBytes: number) {
    const open = this.find(id);
    const window: KeyWatchWindow = {
      watchId: id,
      ...open.ring.window(null, KEY_WATCH_MAX_EVENTS, KEY_WATCH_MAX_RING_BYTES),
      state: open.state,
      completedRevision: open.completedRevision,
      gap: open.gap,
    };
    return captureRetainedWatch(this.summary(open), window, maxBytes);
  }

  list(): readonly KeyWatchSummary[] {
    this.scope.capability("watch");
    return [...this.watches.values()].map((entry) => this.summary(entry));
  }
  async stop(id: string): Promise<void> {
    await this.stopOpen(this.find(id));
  }
  clear(id: string): void {
    this.find(id).ring.clear();
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.watches.values()].map((entry) => this.stopOpen(entry)));
    this.watches.clear();
  }
}
