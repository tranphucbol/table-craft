import { randomUUID } from "node:crypto";
import { isPluginError, type Capability, type Session } from "@table-craft/plugin-api";
import type { EngineContext } from "@table-craft/desktop/engine/context.js";
import { connectDatasource } from "@table-craft/desktop/engine/connect.js";
import { EngineFailure, helperRequestFailed } from "@table-craft/desktop/engine/failures.js";

export const KEY_RESOURCE_LIMIT = 32;
const CLOSE_GRACE_MS = 3_000;
const MAX_QUEUED_OPERATIONS = 128;

export function definitelyNotApplied(cause: unknown): boolean {
  return isPluginError(cause) && (cause.code === "conflict" || ("outcome" in cause && cause.outcome === "notApplied"));
}

export function invalidOperation(message: string): EngineFailure {
  return new EngineFailure({
    code: "invalidRequest",
    message,
    hint: "Refresh the datasource and check the operation's prerequisites.",
  });
}

export function requireMethod<T extends object, K extends keyof T>(
  service: T | undefined,
  key: K,
  name: string,
): T & Required<Pick<T, K>> {
  if (typeof service?.[key] !== "function") throw invalidOperation(`The datasource does not provide ${name}.`);
  return service as T & Required<Pick<T, K>>;
}

export function serviceMethod<T extends object, K extends keyof T>(service: T | undefined, key: K): NonNullable<T[K]> {
  const member = service?.[key];
  if (typeof member !== "function") throw invalidOperation(`The datasource does not provide ${String(key)}.`);
  return member.bind(service) as NonNullable<T[K]>;
}

export async function quietClose(resource: { close(): Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve()
      .then(() => resource.close())
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** Port lifetime authority; async opens remain registered until their late resource is closed. */
export class KeyOperationScope {
  private closed = false;
  private readonly sessions = new Set<Session>();
  private readonly cleanups = new Set<() => Promise<void>>();
  private admin: Promise<Session> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private queued = 0;

  constructor(readonly context: EngineContext) {}

  id(): string {
    return randomUUID();
  }

  live(): void {
    if (this.closed)
      throw new EngineFailure({
        code: "connectionLost",
        message: "This datasource connection has closed.",
        hint: "Reconnect the datasource before starting another operation.",
      });
  }

  capability(capability: Capability): void {
    this.live();
    if (!this.context.datasourcePlugin().capabilities.includes(capability)) {
      throw invalidOperation(`The datasource does not declare ${capability}.`);
    }
  }

  writable(): void {
    this.live();
    if (this.context.options.datasource.readOnly)
      throw invalidOperation("Read-only data source: this operation writes to the cluster.");
  }

  register(close: () => Promise<void>): () => void {
    this.live();
    this.cleanups.add(close);
    return () => {
      this.cleanups.delete(close);
    };
  }

  async open(capability: Capability): Promise<Session> {
    this.capability(capability);
    if (this.sessions.size + this.pending >= KEY_RESOURCE_LIMIT)
      throw invalidOperation("Too many dedicated resources; stop one before starting another.");
    this.pending += 1;
    let session: Session;
    try {
      session = await connectDatasource(this.context.options, this.context.connector);
    } finally {
      this.pending -= 1;
    }
    if (this.closed) {
      await quietClose(session);
      this.live();
    }
    this.sessions.add(session);
    return session;
  }

  async release(session: Session): Promise<void> {
    if (this.sessions.delete(session)) await quietClose(session);
  }

  /** Admin work is serialized once, never routed through the retrying helper. */
  run<T>(capability: Capability, write: boolean, work: (session: Session) => Promise<T>): Promise<T> {
    this.capability(capability);
    if (write) this.writable();
    if (this.queued >= MAX_QUEUED_OPERATIONS)
      throw invalidOperation("Too many pending operations; wait for one to finish.");
    this.queued += 1;
    const result = this.queue
      .then(async () => {
        this.capability(capability);
        if (write) this.writable();
        this.admin ??= this.open(capability).catch((cause: unknown) => {
          this.admin = null;
          throw cause;
        });
        const session = await this.admin;
        this.live();
        try {
          return await work(session);
        } catch (cause) {
          if (
            isPluginError(cause) &&
            (cause.code === "connectionLost" || ("outcome" in cause && cause.outcome === "unknown"))
          ) {
            this.admin = null;
            await this.release(session);
          }
          if (cause instanceof EngineFailure) throw cause;
          if (write && !definitelyNotApplied(cause)) {
            throw new EngineFailure({
              code: "statementFailed",
              message: "The mutation could not be confirmed and may have committed.",
              hint: "Inspect or reload the affected data before trying another mutation; automatic replay is disabled.",
            });
          }
          throw helperRequestFailed(cause);
        }
      })
      .finally(() => {
        this.queued -= 1;
      });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cleanups = [...this.cleanups];
    this.cleanups.clear();
    await Promise.allSettled(cleanups.map((close) => close()));
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(quietClose));
  }
}
