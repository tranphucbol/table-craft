import type {
  KeyWatch,
  KeyWatchBatch,
  KeyWatchEvent,
  KeyWatchGap,
  KeyWatchRequest,
  KeyWatcher,
  KeyWatchState,
} from "@table-craft/plugin-api";
import type { IDuplexStream, IEvent, IWatchRequest, IWatchResponse } from "etcd3";
import { closeStream } from "./client.js";
import { keyBytesOf } from "./keyBytes.js";
import { revisionOf } from "./history.js";
import {
  budget,
  database,
  decimal,
  invalid,
  logicalRange,
  MAX_BYTES,
  MAX_PAGE,
  promised,
  type RuntimeHost,
} from "./runtime.js";

const MAX_BUFFER_EVENTS = 10_000;
const MAX_BUFFER_BYTES = 16_777_216;
const MAX_TIMEOUT = 5000;
const INITIAL_BACKOFF = 100;
const MAX_BACKOFF = 5000;
interface RevisionGroup {
  revision: string;
  events: KeyWatchEvent[];
}
function eventSize(event: KeyWatchEvent): number {
  const size = (value: { text: string; hex: string | null } | null) =>
    value === null ? 0 : value.hex === null ? Buffer.byteLength(value.text) : value.hex.length / 2;
  return size(event.key) + size(event.value) + size(event.previous?.key ?? null) + size(event.previous?.value ?? null);
}
function eventOf(event: IEvent): KeyWatchEvent {
  return {
    kind: event.type === "Delete" ? "DELETE" : "PUT",
    key: keyBytesOf(event.kv.key),
    revision: revisionOf(event.kv),
    value: event.type === "Delete" ? null : keyBytesOf(event.kv.value),
    previous:
      event.prev_kv == null || event.prev_kv.key.length === 0
        ? null
        : {
            key: keyBytesOf(event.prev_kv.key),
            value: keyBytesOf(event.prev_kv.value),
            revision: revisionOf(event.prev_kv),
          },
  };
}
export class EtcdWatcher implements KeyWatcher {
  constructor(readonly host: RuntimeHost) {}
  async open(request: KeyWatchRequest): Promise<KeyWatch> {
    database(request.database);
    this.host.state.check();
    const range = logicalRange(request.range);
    let start: string;
    if (request.from.kind === "revision") start = decimal(request.from.revision, true);
    else {
      const head = await this.host.call((etcd) => etcd.kv.range({ ...range, count_only: true, serializable: false }));
      start = (BigInt(head.header.revision) + 1n).toString();
    }
    let state: KeyWatchState = "reconnecting";
    let completed: string | null = null;
    let gap: KeyWatchGap | null = null;
    let generation = 0;
    let backoff = INITIAL_BACKOFF;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: IDuplexStream<IWatchRequest, IWatchResponse> | undefined;
    let groups: RevisionGroup[] = [];
    let fragments: IEvent[] = [];
    let buffered = 0;
    let bufferedBytes = 0;
    let partialRevision: string | null = null;
    let partialCount = 0;
    let replayRemaining = 0;
    let wake: (() => void) | undefined;
    let pulling = false;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const stopStream = () => {
      generation++;
      const old = stream;
      stream = undefined;
      if (old !== undefined) closeStream(old);
    };
    const markGap = (reason: KeyWatchGap["reason"], toRevision: string | null) => {
      gap = { reason, fromRevision: completed === null ? start : (BigInt(completed) + 1n).toString(), toRevision };
      groups = [];
      fragments = [];
      buffered = 0;
      bufferedBytes = 0;
      state = "gap";
      stopStream();
      clearTimeout(timer);
      notify();
    };
    const close = () =>
      promised(() => {
        if (state === "stopped") return;
        state = "stopped";
        stopStream();
        clearTimeout(timer);
        groups = [];
        fragments = [];
        buffered = 0;
        bufferedBytes = 0;
        notify();
        release();
      });
    const release = this.host.state.own(close);
    const reconnect = (mine: number) => {
      if (mine !== generation || state === "gap" || state === "stopped") return;
      stopStream();
      state = "reconnecting";
      groups = [];
      fragments = [];
      buffered = 0;
      bufferedBytes = 0;
      replayRemaining = partialCount;
      timer = setTimeout(() => {
        void connect();
      }, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      notify();
    };
    const connect = async () => {
      const mine = ++generation;
      try {
        const opened = await this.host.call((etcd) => etcd.watchClient.watch());
        if (mine !== generation || state === "stopped" || state === "gap") {
          closeStream(opened);
          return;
        }
        stream = opened;
        opened.on("error", () => reconnect(mine));
        opened.on("end", () => reconnect(mine));
        opened.on("data", (response) => {
          if (mine !== generation || state === "stopped" || state === "gap") return;
          if (response.canceled) {
            if (BigInt(response.compact_revision || "0") > 0n) markGap("compacted", response.compact_revision);
            else reconnect(mine);
            return;
          }
          state = "live";
          backoff = INITIAL_BACKOFF;
          // Creation headers are not proof of completed event delivery.
          if (response.created) {
            notify();
            return;
          }
          fragments.push(...response.events);
          const addedBytes = response.events.reduce((sum, event) => sum + eventSize(eventOf(event)), 0);
          buffered += response.events.length;
          bufferedBytes += addedBytes;
          if (buffered > MAX_BUFFER_EVENTS || bufferedBytes > MAX_BUFFER_BYTES) {
            markGap("overflow", response.header.revision);
            return;
          }
          if (response.fragment) return;
          for (const raw of fragments) {
            const event = eventOf(raw);
            if (raw.kv.mod_revision === partialRevision && replayRemaining > 0) {
              replayRemaining--;
              buffered--;
              bufferedBytes -= eventSize(event);
              continue;
            }
            if (eventSize(event) > MAX_BYTES) {
              markGap("eventTooLarge", raw.kv.mod_revision);
              return;
            }
            let group = groups.at(-1);
            if (group?.revision !== raw.kv.mod_revision) {
              group = { revision: raw.kv.mod_revision, events: [] };
              groups.push(group);
            }
            group.events.push(event);
          }
          fragments = [];
          notify();
        });
        opened.write({
          create_request: {
            ...range,
            start_revision: completed === null ? start : (BigInt(completed) + 1n).toString(),
            prev_kv: true,
            progress_notify: true,
            fragment: true,
          },
        });
      } catch {
        reconnect(mine);
      }
    };
    void connect();
    return {
      next: async (limits): Promise<KeyWatchBatch> => {
        budget(limits.count, MAX_PAGE, "count");
        budget(limits.maxBytes, MAX_BYTES, "maxBytes");
        budget(limits.timeoutMs, MAX_TIMEOUT, "timeoutMs");
        if (pulling) invalid("Another watch pull is already pending.");
        pulling = true;
        try {
          if (groups.length === 0 && state !== "gap" && state !== "stopped")
            await new Promise<void>((resolve) => {
              const deadline = setTimeout(() => {
                wake = undefined;
                resolve();
              }, limits.timeoutMs);
              wake = () => {
                clearTimeout(deadline);
                resolve();
              };
            });
          const events: KeyWatchEvent[] = [];
          let used = 0;
          while (groups.length > 0 && events.length < limits.count) {
            const group = groups[0]!;
            const event = group.events[0]!;
            const size = eventSize(event);
            if (used + size > limits.maxBytes) {
              if (events.length === 0) markGap("eventTooLarge", group.revision);
              break;
            }
            group.events.shift();
            events.push(event);
            used += size;
            buffered--;
            bufferedBytes -= size;
            if (partialRevision !== group.revision) {
              partialRevision = group.revision;
              partialCount = 0;
            }
            partialCount++;
            if (group.events.length === 0) {
              completed = group.revision;
              groups.shift();
              partialRevision = null;
              partialCount = 0;
            }
          }
          return { events, state, completedRevision: completed, gap };
        } finally {
          pulling = false;
        }
      },
      close,
    };
  }
}
