import type {
  LeaseInfo,
  LeaseKeepAlive,
  LeaseKeyPage,
  LeaseManager,
  LeaseRevokePreview,
} from "@table-craft/plugin-api";
import type { IDuplexStream, ILeaseKeepAliveRequest, ILeaseKeepAliveResponse, ILeaseTimeToLiveResponse } from "etcd3";
import { closeStream } from "./client.js";
import { keyBytesOf } from "./keyBytes.js";
import {
  budget,
  decimal,
  invalid,
  leaseId,
  MAX_PAGE,
  promised,
  refuse,
  writable,
  type RuntimeHost,
} from "./runtime.js";

const SAMPLE_KEYS = 10;
const HEARTBEAT_TIMEOUT_MS = 5000;
const MIN_HEARTBEAT_MS = 1000;
const MS_PER_SECOND = 1000;
const HEARTBEAT_UNCONFIRMED = "Lease renewal was not confirmed. Inspect its remaining TTL.";
const RENEWAL_FAILED = "Lease renewal failed. Inspect its remaining TTL before continuing.";
const RENEWAL_ENDED = "etcd ended the lease renewal stream. Inspect its remaining TTL before continuing.";
const LEASE_EXPIRED = "The lease expired or was revoked; renewal stopped.";
interface LeasePreview {
  readonly kind: "lease";
  readonly id: string;
  readonly keys: readonly string[];
}

export class EtcdLeases implements LeaseManager {
  constructor(readonly host: RuntimeHost) {}
  async #live(id: string, keys = true): Promise<ILeaseTimeToLiveResponse> {
    this.host.state.check();
    leaseId(id);
    return this.host.globalCall((etcd) => etcd.leaseClient.leaseTimeToLive({ ID: id, keys }));
  }
  #info(live: ILeaseTimeToLiveResponse, known: boolean): LeaseInfo {
    const scoped = live.keys.filter((key) => this.host.namespace.contains(key));
    return {
      id: live.ID,
      state: BigInt(live.TTL) > 0n ? "active" : "expired",
      grantedTtlSeconds: live.grantedTTL,
      remainingTtlSeconds: live.TTL,
      scopedKeyCount: known ? String(scoped.length) : null,
      totalKeyCount: known ? String(live.keys.length) : null,
      outsideNamespaceKeyCount: known ? String(live.keys.length - scoped.length) : null,
    };
  }
  async list(): Promise<readonly LeaseInfo[]> {
    this.host.state.check();
    const response = await this.host.globalCall((etcd) => etcd.leaseClient.leaseLeases());
    return response.leases.map(({ ID }) => ({
      id: ID,
      state: "unknown",
      grantedTtlSeconds: null,
      remainingTtlSeconds: null,
      scopedKeyCount: null,
      totalKeyCount: null,
      outsideNamespaceKeyCount: null,
    }));
  }
  async get(id: string): Promise<LeaseInfo> {
    return this.#info(await this.#live(id, false), false);
  }
  async keys(id: string, cursor: string | null, count: number): Promise<LeaseKeyPage> {
    budget(count, MAX_PAGE, "count");
    const live = await this.#live(id);
    const binding = `lease:${id}`;
    const position = cursor === null ? null : this.host.state.read<{ binding: string; after: string }>(cursor, binding);
    const all = live.keys
      .filter((key) => this.host.namespace.contains(key))
      .sort((left, right) => Buffer.compare(left, right));
    const eligible =
      position === null ? all : all.filter((key) => Buffer.compare(key, Buffer.from(position.after, "hex")) > 0);
    const page = eligible.slice(0, count);
    const last = page.at(-1);
    return {
      lease: this.#info(live, true),
      keys: page.map((key) => keyBytesOf(this.host.namespace.strip(key))),
      cursor:
        eligible.length > page.length && last !== undefined
          ? this.host.state.cursor({ binding, after: last.toString("hex") })
          : null,
    };
  }
  async grant(ttlSeconds: string): Promise<LeaseInfo> {
    writable(this.host.readOnly);
    decimal(ttlSeconds, true);
    this.host.state.check();
    const result = await this.host.globalCall((etcd) => etcd.leaseClient.leaseGrant({ TTL: ttlSeconds }));
    return {
      id: result.ID,
      state: "active",
      grantedTtlSeconds: result.TTL,
      remainingTtlSeconds: result.TTL,
      scopedKeyCount: "0",
      totalKeyCount: "0",
      outsideNamespaceKeyCount: "0",
    };
  }
  async keepAliveOnce(id: string): Promise<LeaseInfo> {
    const handle = await this.#heartbeat(id, false);
    try {
      return await handle.once();
    } finally {
      await handle.close();
    }
  }
  keepAlive(id: string): Promise<LeaseKeepAlive> {
    return this.#heartbeat(id, true);
  }
  async #heartbeat(id: string, continuous: boolean): Promise<LeaseKeepAlive> {
    writable(this.host.readOnly);
    leaseId(id);
    this.host.state.check();
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: IDuplexStream<ILeaseKeepAliveRequest, ILeaseKeepAliveResponse> | undefined;
    let pending: { resolve(info: LeaseInfo): void; reject(error: unknown): void } | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let listener: ((reason: string) => void) | undefined;
    let stoppedReason: string | undefined;
    const finish = (reason: string | null) =>
      promised(() => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearTimeout(timeout);
        if (reason !== null) stoppedReason = reason;
        if (stream !== undefined) closeStream(stream);
        pending?.reject(new Error(reason ?? "Lease renewal stopped; the lease was not revoked."));
        pending = undefined;
        release();
        if (reason !== null) {
          listener?.(reason);
        }
      });
    const close = () => finish(null);
    const release = this.host.state.own(close);
    const onClosed = (next: (reason: string) => void) => {
      listener = next;
      if (stoppedReason !== undefined) next(stoppedReason);
    };
    const once = (): Promise<LeaseInfo> => {
      writable(this.host.readOnly);
      this.host.state.check();
      if (closed) return Promise.reject(new Error("Lease renewal is closed."));
      if (pending !== undefined) return Promise.reject(new Error("Lease heartbeat is already pending."));
      clearTimeout(timer);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        timeout = setTimeout(() => {
          void finish(HEARTBEAT_UNCONFIRMED);
        }, HEARTBEAT_TIMEOUT_MS);
        try {
          stream!.write({ ID: id });
        } catch (error) {
          pending = undefined;
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
          void finish(RENEWAL_FAILED);
        }
      });
    };
    try {
      stream = await this.host.globalCall((etcd) => etcd.leaseClient.leaseKeepAlive());
      if (closed) {
        closeStream(stream);
        return { once, close, onClosed };
      }
      stream.on("error", () => {
        void finish(RENEWAL_FAILED);
      });
      stream.on("end", () => {
        void finish(RENEWAL_ENDED);
      });
      stream.on("data", (response) => {
        if (closed || response.ID !== id) return;
        clearTimeout(timeout);
        clearTimeout(timer);
        const info: LeaseInfo = {
          id,
          state: BigInt(response.TTL) > 0n ? "active" : "expired",
          grantedTtlSeconds: null,
          remainingTtlSeconds: response.TTL,
          scopedKeyCount: null,
          totalKeyCount: null,
          outsideNamespaceKeyCount: null,
        };
        pending?.resolve(info);
        pending = undefined;
        if (!continuous) return;
        if (info.state !== "active") {
          void finish(LEASE_EXPIRED);
          return;
        }
        const seconds = BigInt(response.TTL);
        const delay = Number(seconds > 60n ? 20n : seconds / 3n) * MS_PER_SECOND;
        timer = setTimeout(
          () => {
            void once().catch(() => finish(RENEWAL_FAILED));
          },
          Math.max(MIN_HEARTBEAT_MS, delay),
        );
      });
      if (continuous) await once();
      return { once, close, onClosed };
    } catch (error) {
      await close();
      throw error;
    }
  }
  async prepareRevoke(id: string): Promise<LeaseRevokePreview> {
    const live = await this.#live(id);
    const keys = live.keys.map((key) => key.toString("hex")).sort();
    return {
      token: this.host.state.token({ kind: "lease", id, keys } satisfies LeasePreview),
      lease: this.#info(live, true),
      sampleKeys: live.keys
        .filter((key) => this.host.namespace.contains(key))
        .slice(0, SAMPLE_KEYS)
        .map((key) => keyBytesOf(this.host.namespace.strip(key))),
    };
  }
  async revokePrepared(token: string): Promise<void> {
    writable(this.host.readOnly);
    const preview = this.host.state.take<LeasePreview>(token);
    if (preview.kind !== "lease") invalid("This is not a lease preview token.");
    const live = await this.#live(preview.id);
    if (JSON.stringify(live.keys.map((key) => key.toString("hex")).sort()) !== JSON.stringify(preview.keys))
      refuse("Lease attachments changed. Prepare a new global revoke preview.");
    await this.host.globalCall((etcd) => etcd.leaseClient.leaseRevoke({ ID: preview.id }));
  }
}
