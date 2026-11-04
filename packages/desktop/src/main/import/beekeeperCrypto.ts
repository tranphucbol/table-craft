import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Opens values Beekeeper Studio sealed with `simple-encryptor` 3 (MIT): the key is SHA-256 of the
 * key string, and a sealed value is hex HMAC-SHA256 over the rest, hex IV, then base64 AES-256-CBC
 * of the value's JSON. Written from that format, not copied.
 */

/** Beekeeper's constant wrapper key for `.key` (`apps/studio/src/common/encryption_key.ts:14`). */
export const BEEKEEPER_WRAPPER_KEY = "38782F413F442A472D4B6150645367566B59703373367639792442264529482B";

const HMAC_HEX_LENGTH = 64;
const IV_HEX_LENGTH = 32;
const CIPHER = "aes-256-cbc";
const DIGEST = "sha256";
const HEX = /^[0-9a-f]*$/i;

/** The value `simple-encryptor` sealed under `key`, or null when the HMAC or the JSON does not check out. */
export function openSealed(key: string, sealed: string): unknown {
  const text = sealed.trim();
  if (text.length <= HMAC_HEX_LENGTH + IV_HEX_LENGTH) return null;
  const mac = text.slice(0, HMAC_HEX_LENGTH);
  const body = text.slice(HMAC_HEX_LENGTH);
  const iv = body.slice(0, IV_HEX_LENGTH);
  if (!HEX.test(mac) || !HEX.test(iv)) return null;
  const cryptoKey = createHash(DIGEST).update(key).digest();
  const expected = createHmac(DIGEST, cryptoKey).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return null;
  try {
    const decipher = createDecipheriv(CIPHER, cryptoKey, Buffer.from(iv, "hex"));
    const json = decipher.update(body.slice(IV_HEX_LENGTH), "base64", "utf8") + decipher.final("utf8");
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** The per-install key from the text of Beekeeper's `.key`, or null when it does not open. */
export function beekeeperKey(keyFileText: string): string | null {
  const opened = openSealed(BEEKEEPER_WRAPPER_KEY, keyFileText);
  if (typeof opened !== "object" || opened === null) return null;
  const key = (opened as { encryptionKey?: unknown }).encryptionKey;
  return typeof key === "string" && key !== "" ? key : null;
}
