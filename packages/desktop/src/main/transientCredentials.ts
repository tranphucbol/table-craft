import { randomUUID } from "node:crypto";

const CREDENTIAL_TTL_MS = 60_000;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

export interface CredentialOwner {
  readonly engineId: string;
  readonly ownerId: string;
  readonly operation: "access.secret.apply";
}

interface Credential extends CredentialOwner {
  readonly bytes: Buffer;
  readonly expires: number;
}

/** A separate write-only IPC lane; never register this as an EngineCall or return the secret. */
export class TransientCredentials {
  readonly #values = new Map<string, Credential>();

  issue(owner: CredentialOwner, secret: string): string {
    this.prune();
    const bytes = Buffer.from(secret, "utf8");
    if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) {
      bytes.fill(0);
      throw new Error("Enter a password within the supported size limit.");
    }
    const id = randomUUID();
    this.#values.set(id, { ...owner, bytes, expires: Date.now() + CREDENTIAL_TTL_MS });
    return id;
  }

  async apply(
    id: string,
    owner: CredentialOwner,
    deliverPrivately: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    this.prune();
    const credential = this.#values.get(id);
    if (
      credential === undefined ||
      credential.engineId !== owner.engineId ||
      credential.ownerId !== owner.ownerId ||
      credential.operation !== owner.operation
    ) {
      throw new Error("The password authorization expired. Enter it again.");
    }
    this.#values.delete(id);
    try {
      await deliverPrivately(credential.bytes);
    } catch {
      // Driver errors can contain the request; only a fixed message crosses this boundary.
      throw new Error("The password change could not be confirmed. Check access before trying again.");
    } finally {
      credential.bytes.fill(0);
    }
  }

  revokeEngine(engineId: string): void {
    for (const [id, value] of this.#values) if (value.engineId === engineId) this.#erase(id, value);
  }

  prune(): void {
    for (const [id, value] of this.#values) if (value.expires <= Date.now()) this.#erase(id, value);
  }

  revokeOwner(engineId: string, ownerId: string): void {
    for (const [id, value] of this.#values)
      if (value.engineId === engineId && value.ownerId === ownerId) this.#erase(id, value);
  }

  #erase(id: string, value: Credential): void {
    value.bytes.fill(0);
    this.#values.delete(id);
  }
}
