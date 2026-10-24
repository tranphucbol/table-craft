/**
 * Wording for TLS failures shared by the network plugins (decision 072). Pure: each plugin reads
 * its files and drives its own driver, and hands the error here to say what did not match.
 */

/** Node's codes for a server certificate whose chain the trusted CAs do not vouch for. */
export const TLS_CHAIN_CODES: readonly string[] = [
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
];

/** Node's codes for a server certificate outside its validity dates. */
const TLS_DATE_CODES: readonly string[] = ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"];

/** Node's code for a certificate that does not name the host it was checked against. */
export const TLS_HOST_CODE = "ERR_TLS_CERT_ALTNAME_INVALID";

/** Node's codes for a private key it could not decrypt with the passphrase given, or without one. */
const BAD_DECRYPT_CODES: readonly string[] = [
  "ERR_OSSL_BAD_DECRYPT",
  "ERR_OSSL_EVP_BAD_DECRYPT",
  "ERR_MISSING_PASSPHRASE",
];

const HOME_PREFIX = /^~(?=$|[/\\])/;

/** `path` with a leading `~` replaced by `home`, as a shell would; any other path unchanged. */
export function homeExpanded(path: string, home: string): string {
  return path.replace(HOME_PREFIX, () => home);
}

const FILE_REASONS: Readonly<Record<string, string>> = {
  ENOENT: "the file does not exist",
  EACCES: "permission denied",
  EPERM: "permission denied",
  EISDIR: "it is a folder, not a file",
};

/** What a verifying connection checked the server certificate against. */
export interface TlsVerification {
  /** The CA file field's form label, such as `SSL root certificate`. */
  readonly caLabel: string;
  /** The CA file's path; null when the system's trusted CAs were used. */
  readonly caPath: string | null;
  /** The host name the certificate had to carry. */
  readonly host: string;
}

function codeOf(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  return typeof cause.code === "string" ? cause.code : null;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * OpenSSL's `X509_verify_cert_error_string` for each code, lower-cased and with hyphens as spaces:
 * OpenSSL 3 writes "self-signed", BoringSSL (Electron) "self signed".
 */
const VERIFY_REASONS: Readonly<Record<string, string>> = {
  "unable to verify the first certificate": "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "unable to get issuer certificate": "UNABLE_TO_GET_ISSUER_CERT",
  "unable to get local issuer certificate": "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "self signed certificate in certificate chain": "SELF_SIGNED_CERT_IN_CHAIN",
  "self signed certificate": "DEPTH_ZERO_SELF_SIGNED_CERT",
  "certificate signature failure": "CERT_SIGNATURE_FAILURE",
  "certificate not trusted": "CERT_UNTRUSTED",
  "certificate has expired": "CERT_HAS_EXPIRED",
  "certificate is not yet valid": "CERT_NOT_YET_VALID",
};

const KNOWN_CODES: readonly string[] = [...TLS_CHAIN_CODES, ...TLS_DATE_CODES, TLS_HOST_CODE];

/**
 * Node's code for a TLS failure. A driver may overwrite it (mysql2 sets `HANDSHAKE_SSL_ERROR`,
 * `lib/commands/client_handshake.js`), so the error is recognised by what survives: the
 * `reason`, `host` and `cert` of a `checkServerIdentity` error, or OpenSSL's message.
 */
function tlsCodeOf(cause: unknown): string | null {
  const code = codeOf(cause);
  if (code !== null && KNOWN_CODES.includes(code)) return code;
  if (typeof cause !== "object" || cause === null) return null;
  if ("reason" in cause && "host" in cause && "cert" in cause) return TLS_HOST_CODE;
  return VERIFY_REASONS[reasonOf(cause).toLowerCase().replaceAll("-", " ")] ?? null;
}

/**
 * Says what a verification failure did not match, or null when `cause` is not one: the CA file
 * (or the system's CAs) for a chain error, the host name for a name mismatch.
 */
export function tlsFailureMessage(cause: unknown, verification: TlsVerification): string | null {
  const code = tlsCodeOf(cause);
  if (code === null) return null;
  const reason = reasonOf(cause);
  if (code === TLS_HOST_CODE) {
    return `The server certificate is not valid for host ${verification.host} (${reason}). Use Verify CA to check the certificate without its host name.`;
  }
  if (TLS_DATE_CODES.includes(code)) return `The server certificate is outside its validity dates (${reason}).`;
  if (!TLS_CHAIN_CODES.includes(code)) return null;
  const { caLabel, caPath } = verification;
  if (caPath === null) {
    return `The server certificate is not signed by a CA this system trusts (${reason}). Choose the server's CA file as the ${caLabel}.`;
  }
  return `The server certificate is not signed by the CA in ${caPath} (${caLabel}): ${reason}.`;
}

/** Words a failure to read one of the TLS files, naming the field and the path. */
export function tlsFileMessage(label: string, path: string, cause: unknown): string {
  const code = codeOf(cause);
  const reason = (code === null ? undefined : FILE_REASONS[code]) ?? reasonOf(cause);
  return `Cannot read the ${label} ${path}: ${reason}.`;
}

const ENCRYPTED_KEY = /-----BEGIN ENCRYPTED PRIVATE KEY-----|^Proc-Type: 4,ENCRYPTED/m;

/** Whether a PEM private key needs a passphrase: PKCS#8 encrypted, or traditional with `Proc-Type`. */
export function tlsKeyIsEncrypted(text: string): boolean {
  return ENCRYPTED_KEY.test(text);
}

/**
 * Words a client key or certificate OpenSSL refused, naming the key file. Any failure on an
 * `encrypted` key is put down to the passphrase, since OpenSSL's codes for it vary by version.
 */
export function tlsKeyMessage(label: string, path: string, cause: unknown, encrypted = false): string {
  const code = codeOf(cause);
  if (encrypted || (code !== null && BAD_DECRYPT_CODES.includes(code))) {
    return `Cannot decrypt the ${label} ${path}: the passphrase is wrong or missing.`;
  }
  return `Cannot use the ${label} ${path}: ${reasonOf(cause)}.`;
}
