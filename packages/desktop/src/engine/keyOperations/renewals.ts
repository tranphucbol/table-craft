import type { LeaseKeepAlive, Session } from "@table-craft/plugin-api";
import type { LeaseKeepAliveStarted, ManagedLeaseInfo } from "@table-craft/desktop/engine/protocol.js";
import { type KeyOperationScope, KEY_RESOURCE_LIMIT, invalidOperation, quietClose, requireMethod } from "./scope.js";

interface Renewal {
  readonly session: Session;
  readonly resource: LeaseKeepAlive;
  closed: boolean;
  closing: Promise<void> | null;
  readonly lease: ManagedLeaseInfo;
}

export class KeyRenewals {
  private readonly renewals = new Map<string, Renewal>();
  private readonly stopped = new Map<string, ManagedLeaseInfo>();
  constructor(private readonly scope: KeyOperationScope) {
    scope.register(() => this.close());
  }

  async start(leaseId: string): Promise<LeaseKeepAliveStarted> {
    this.scope.capability("leases");
    this.scope.writable();
    if (this.renewals.size >= KEY_RESOURCE_LIMIT) throw invalidOperation("Too many renewing leases; stop one first.");
    const session = await this.scope.open("leases");
    let resource: LeaseKeepAlive | undefined;
    try {
      const manager = session.leases;
      resource = await requireMethod(manager, "keepAlive", "leases.keepAlive").keepAlive(leaseId);
      this.scope.live();
      const lease = await requireMethod(manager, "get", "leases.get").get(leaseId);
      this.scope.live();
      requireMethod(resource, "close", "lease renewal.close");
      const id = this.scope.id();
      const held: Renewal = { session, resource, lease, closed: false, closing: null };
      this.renewals.set(id, held);
      this.stopped.delete(leaseId);
      resource.onClosed?.((reason) => {
        if (held.closed) return;
        while (this.stopped.size >= KEY_RESOURCE_LIMIT) this.stopped.delete(this.stopped.keys().next().value!);
        this.stopped.set(leaseId, { ...lease, renewal: { keepAliveId: id, state: "stopped", reason } });
        void this.stopHeld(id, held);
      });
      return { keepAliveId: id, lease };
    } catch (cause) {
      if (resource !== undefined) await quietClose(resource);
      await this.scope.release(session);
      throw cause;
    }
  }

  list(leases: readonly ManagedLeaseInfo[]): readonly ManagedLeaseInfo[] {
    const result = new Map(leases.map((lease) => [lease.id, lease]));
    for (const [leaseId, stopped] of this.stopped)
      result.set(leaseId, {
        ...(result.get(leaseId) ?? { ...stopped, state: "unknown", remainingTtlSeconds: null }),
        renewal: stopped.renewal,
      });
    for (const [id, held] of this.renewals)
      result.set(held.lease.id, {
        ...(result.get(held.lease.id) ?? { ...held.lease, state: "unknown", remainingTtlSeconds: null }),
        renewal: { keepAliveId: id, state: "active", reason: null },
      });
    return [...result.values()];
  }

  private stopHeld(id: string, held: Renewal): Promise<void> {
    if (held.closing !== null) return held.closing;
    held.closed = true;
    this.renewals.delete(id);
    held.closing = quietClose(held.resource).then(() => this.scope.release(held.session));
    return held.closing;
  }

  async stop(id: string): Promise<void> {
    this.scope.capability("leases");
    const held = this.renewals.get(id);
    if (held === undefined) {
      const stopped = [...this.stopped].find(([, lease]) => lease.renewal?.keepAliveId === id);
      if (stopped !== undefined) {
        this.stopped.delete(stopped[0]);
        return;
      }
      throw invalidOperation("No renewal with this ID belongs to this connection.");
    }
    await this.stopHeld(id, held);
  }

  async close(): Promise<void> {
    this.stopped.clear();
    await Promise.allSettled([...this.renewals].map(([id, held]) => this.stopHeld(id, held)));
  }
}
