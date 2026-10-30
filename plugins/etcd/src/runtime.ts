import { PluginError, type KeyRange } from "@table-craft/plugin-api";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import type { Call } from "./admin.js";
import { NamespaceMapper } from "./namespace.js";

export const MAX_PAGE = 500;
export const MAX_BYTES = 1_048_576;
export const MAX_OPS = 128;
const MAX_CURSOR = 8192;
const SECRET_BYTES = 32;

/** Runs `work` now, with an async function's contract: a throw becomes the rejection. */
export function promised(work: () => void): Promise<void> {
  return new Promise((resolve) => {
    work();
    resolve();
  });
}
export function invalid(message: string): never {
  throw new EtcdRefusal(message);
}
/**
 * A write refused before anything reached etcd, so nothing changed; the host reports the message as
 * it is instead of as a mutation that may have committed. Structural (`outcome`), like
 * `EtcdAmbiguousError`, because the host sees another bundle's class.
 */
export class EtcdRefusal extends PluginError {
  readonly outcome = "notApplied";
  constructor(message: string) {
    super("statementFailed", message);
  }
}
export function refuse(message: string): never {
  throw new EtcdRefusal(message);
}
/** A guarded transaction etcd answered with `succeeded: false`: it wrote nothing. */
export function guardFailed(message: string): never {
  throw new PluginError("conflict", message);
}
export function budget(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    invalid(`${name} must be between 1 and ${String(max)}.`);
}
export function decimal(value: string, positive = false): string {
  if (!/^(0|[1-9]\d{0,19})$/.test(value) || (positive && value === "0"))
    invalid("Use a canonical positive decimal integer.");
  return value;
}
export function leaseId(value: string): string {
  if (!/^-?[1-9]\d{0,19}$/.test(value)) invalid("Use a nonzero decimal lease ID.");
  return value;
}
export function database(value: number): void {
  if (value !== 0) invalid("etcd has one keyspace, database 0.");
}
export function writable(readOnly: boolean): void {
  if (readOnly) refuse("Read-only datasource refuses this operation. Turn off Read-only to write.");
}
export const logicalMapper = new NamespaceMapper();
export function logicalRange(range: KeyRange) {
  return logicalMapper.range(range);
}

/** Session-bound authenticated cursors and bounded one-use preview tokens. */
export class RuntimeState {
  #secret: Buffer | null = randomBytes(SECRET_BYTES);
  readonly #tokens = new Map<string, unknown>();
  readonly #resources = new Set<() => Promise<void>>();
  check(): void {
    if (this.#secret === null) throw new PluginError("connectionLost", "The etcd session is closed.");
  }
  cursor(value: unknown): string {
    this.check();
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${this.#sign(payload)}`;
  }
  read<T>(cursor: string, binding: string): T {
    this.check();
    try {
      if (cursor.length > MAX_CURSOR) throw new Error();
      const [payload, signature, extra] = cursor.split(".");
      if (!payload || !signature || extra !== undefined) throw new Error();
      const actual = Buffer.from(signature);
      const expected = Buffer.from(this.#sign(payload));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T & { binding: string };
      if (value.binding !== binding) throw new Error();
      return value;
    } catch {
      return invalid("Invalid or expired etcd cursor. Start a new read.");
    }
  }
  token(value: unknown): string {
    this.check();
    if (this.#tokens.size >= MAX_PAGE) invalid("Too many pending previews. Reconnect before preparing another.");
    const token = randomBytes(SECRET_BYTES).toString("base64url");
    this.#tokens.set(token, structuredClone(value));
    return token;
  }
  take<T>(token: string): T {
    this.check();
    const value = this.#tokens.get(token);
    this.#tokens.delete(token);
    if (value === undefined) refuse("Preview expired or already used. Prepare a new preview.");
    return value as T;
  }
  own(close: () => Promise<void>): () => void {
    this.check();
    this.#resources.add(close);
    return () => this.#resources.delete(close);
  }
  async close(): Promise<void> {
    this.#secret?.fill(0);
    this.#secret = null;
    this.#tokens.clear();
    await Promise.allSettled([...this.#resources].map((close) => close()));
    this.#resources.clear();
  }
  #sign(payload: string): string {
    return createHmac("sha256", this.#secret!).update(payload).digest("base64url");
  }
}
export interface RuntimeHost {
  readonly call: Call;
  readonly globalCall: Call;
  readonly namespace: NamespaceMapper;
  readonly state: RuntimeState;
  readonly readOnly: boolean;
  readonly clusterId: string;
}
