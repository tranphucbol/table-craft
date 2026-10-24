import { createHash } from "node:crypto";

/** What an SSH server offered as its host key, as the trust prompt and the known-hosts store see it. */
export interface HostKeyOffer {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  /** `SHA256:` and the unpadded base64 digest, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string;
  /** The key blob in base64, as a `known_hosts` line holds it. */
  readonly key: string;
}

/** Resolves to trust the key; rejects with a `TunnelError` to refuse it. */
export type HostKeyVerifier = (offer: HostKeyOffer) => Promise<void>;

const FINGERPRINT_PREFIX = "SHA256:";
const BASE64_PADDING = /=+$/;
const LENGTH_BYTES = 4;

/** The OpenSSH fingerprint of a key blob. */
export function fingerprintOf(key: Buffer): string {
  return FINGERPRINT_PREFIX + createHash("sha256").update(key).digest("base64").replace(BASE64_PADDING, "");
}

/** The algorithm name a key blob starts with (RFC 4253 §6.6), such as `ssh-ed25519`. */
export function algorithmOf(key: Buffer): string {
  if (key.length < LENGTH_BYTES) return "";
  const length = key.readUInt32BE(0);
  return key.subarray(LENGTH_BYTES, LENGTH_BYTES + length).toString("latin1");
}

export function hostKeyOffer(host: string, port: number, key: Buffer): HostKeyOffer {
  return { host, port, algorithm: algorithmOf(key), fingerprint: fingerprintOf(key), key: key.toString("base64") };
}

const OPENSSH_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END = "-----END OPENSSH PRIVATE KEY-----";
const OPENSSH_MAGIC = "openssh-key-v1\0";
const OPENSSH_NO_CIPHER = "none";
const PEM_ENCRYPTED_HEADER = /^Proc-Type:\s*4,ENCRYPTED/m;
const PKCS8_ENCRYPTED_BEGIN = "-----BEGIN ENCRYPTED PRIVATE KEY-----";
const PPK_ENCRYPTION = /^Encryption:\s*(\S+)/m;

function openSshCipher(text: string): string | null {
  const start = text.indexOf(OPENSSH_BEGIN);
  const end = text.indexOf(OPENSSH_END);
  if (start < 0 || end < start) return null;
  const body = Buffer.from(text.slice(start + OPENSSH_BEGIN.length, end).replace(/\s+/g, ""), "base64");
  if (body.toString("latin1", 0, OPENSSH_MAGIC.length) !== OPENSSH_MAGIC) return null;
  return algorithmOf(body.subarray(OPENSSH_MAGIC.length));
}

/**
 * Whether a private key file is encrypted, read from its header alone, so main can ask for the
 * passphrase without loading ssh2. Unknown formats answer false and let the handshake say why.
 */
export function keyNeedsPassphrase(text: string): boolean {
  const cipher = openSshCipher(text);
  if (cipher !== null) return cipher !== OPENSSH_NO_CIPHER;
  if (text.includes(PKCS8_ENCRYPTED_BEGIN) || PEM_ENCRYPTED_HEADER.test(text)) return true;
  const ppk = PPK_ENCRYPTION.exec(text);
  return ppk !== null && ppk[1] !== OPENSSH_NO_CIPHER;
}
