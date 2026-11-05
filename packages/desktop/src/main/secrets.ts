import { join } from "node:path";
import { z } from "@table-craft/plugin-api";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";
import type { SecretMode } from "@table-craft/desktop/preload/bridge.js";

export const SECRETS_FILE = "secrets.json";
const SECRETS_VERSION = 2;
const FIRST_SECRETS_VERSION = 1;
const JSON_INDENT = 2;

/** `safeStorage`, injected so tests can run without a keychain and make one unavailable. */
export interface Cipher {
  isAvailable(): boolean;
  /** Ciphertext as base64, so it survives JSON. */
  encrypt(plain: string): string;
  /** Throws when the keychain entry that encrypted it is gone. */
  decrypt(cipherText: string): string;
}

export const ENCRYPTION_UNAVAILABLE_REASON =
  "The system keychain is not available, so secrets cannot be kept Forever. Choose Until restart or Never.";

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

const fileSchema = z.strictObject({
  version: z.union([z.literal(FIRST_SECRETS_VERSION), z.literal(SECRETS_VERSION)]),
  /** Ciphertext by datasource id, then by field key. */
  secrets: z.record(z.string(), z.record(z.string(), z.string())),
  /** Ciphertext of each plugin registry's token, by registry id (decision 158). */
  registries: z.record(z.string(), z.string()).optional(),
});

type Secrets = Record<string, Record<string, string>>;

export interface SecretStore {
  encryption(): { readonly available: boolean; readonly reason: string | null };
  /** Stores `value` the way `mode` says, removing it from every other place. */
  set(datasourceId: string, key: string, mode: SecretMode, value: string): Promise<void>;
  /** Moves a stored value to `mode`'s place; `never` forgets it. */
  changeMode(datasourceId: string, key: string, from: SecretMode, to: SecretMode): Promise<void>;
  /** The value main can use without asking, or undefined when the user must type it. */
  get(datasourceId: string, key: string, mode: SecretMode): string | undefined;
  clear(datasourceId: string, key: string): Promise<void>;
  clearAll(datasourceId: string): Promise<void>;
  /** A plugin registry's token, always kept Forever: it is refused when encryption is unavailable. */
  setRegistryToken(registryId: string, token: string): Promise<void>;
  registryToken(registryId: string): string | undefined;
  clearRegistryToken(registryId: string): Promise<void>;
}

export interface SecretStoreOptions {
  readonly directory: string;
  readonly files: FileSystem;
  readonly cipher: Cipher;
}

/**
 * Decision 020's three save modes. Forever is `safeStorage` ciphertext in `secrets.json`; Until
 * restart lives in this object only; Never is not kept at all. There is no plaintext fallback:
 * when encryption is unavailable, Forever is refused.
 */
export async function createSecretStore(options: SecretStoreOptions): Promise<SecretStore> {
  const path = join(options.directory, SECRETS_FILE);
  const memory = new Map<string, Map<string, string>>();
  const text = await options.files.readText(path);
  const parsed = text === null ? null : fileSchema.safeParse(safeJson(text));
  // An unreadable secrets file behaves like a lost keychain: every Forever secret is asked for again.
  const persisted: Secrets = parsed?.success === true ? parsed.data.secrets : {};
  const registries: Record<string, string> = parsed?.success === true ? { ...parsed.data.registries } : {};

  async function persist(): Promise<void> {
    const file = { version: SECRETS_VERSION, secrets: persisted, registries };
    await writeAtomically(options.files, path, `${JSON.stringify(file, null, JSON_INDENT)}\n`);
  }

  function remember(datasourceId: string, key: string, value: string): void {
    const values = memory.get(datasourceId) ?? new Map<string, string>();
    values.set(key, value);
    memory.set(datasourceId, values);
  }

  function forget(datasourceId: string, key: string): boolean {
    memory.get(datasourceId)?.delete(key);
    const stored = persisted[datasourceId];
    if (stored?.[key] === undefined) return false;
    delete stored[key];
    if (Object.keys(stored).length === 0) delete persisted[datasourceId];
    return true;
  }

  function decrypted(cipherText: string | undefined): string | undefined {
    if (cipherText === undefined || !options.cipher.isAvailable()) return undefined;
    try {
      return options.cipher.decrypt(cipherText);
    } catch {
      return undefined;
    }
  }

  const store: SecretStore = {
    encryption() {
      const available = options.cipher.isAvailable();
      return { available, reason: available ? null : ENCRYPTION_UNAVAILABLE_REASON };
    },
    async set(datasourceId, key, mode, value) {
      if (mode === "forever" && !options.cipher.isAvailable()) {
        throw new SecretStoreError(ENCRYPTION_UNAVAILABLE_REASON, "Pick another save mode for the secret.");
      }
      const hadPersisted = forget(datasourceId, key);
      if (mode === "untilRestart") remember(datasourceId, key, value);
      if (mode === "forever") {
        persisted[datasourceId] = { ...persisted[datasourceId], [key]: options.cipher.encrypt(value) };
      }
      if (mode === "forever" || hadPersisted) await persist();
    },
    async changeMode(datasourceId, key, from, to) {
      if (from === to) return;
      const value = store.get(datasourceId, key, from);
      if (value === undefined || to === "never") {
        await store.clear(datasourceId, key);
        return;
      }
      await store.set(datasourceId, key, to, value);
    },
    get(datasourceId, key, mode) {
      if (mode === "never") return undefined;
      if (mode === "untilRestart") return memory.get(datasourceId)?.get(key);
      return decrypted(persisted[datasourceId]?.[key]);
    },
    async clear(datasourceId, key) {
      if (forget(datasourceId, key)) await persist();
    },
    async clearAll(datasourceId) {
      memory.delete(datasourceId);
      if (persisted[datasourceId] === undefined) return;
      delete persisted[datasourceId];
      await persist();
    },
    async setRegistryToken(registryId, token) {
      if (!options.cipher.isAvailable()) {
        throw new SecretStoreError(
          ENCRYPTION_UNAVAILABLE_REASON,
          "A registry token is only kept encrypted; make the system keychain available and try again.",
        );
      }
      registries[registryId] = options.cipher.encrypt(token);
      await persist();
    },
    registryToken(registryId) {
      return decrypted(registries[registryId]);
    },
    async clearRegistryToken(registryId) {
      if (registries[registryId] === undefined) return;
      delete registries[registryId];
      await persist();
    },
  };
  return store;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
