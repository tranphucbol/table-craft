import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { TLSSocket } from "node:tls";
import {
  homeExpanded,
  PluginError,
  TlsSettingsError,
  tlsFailureMessage,
  tlsFileMessage,
  tlsKeyMessage,
  type TlsInfo,
} from "@table-craft/plugin-api";

export const ENCRYPT_MODES = ["optional", "mandatory", "strict"] as const;

export type EncryptMode = (typeof ENCRYPT_MODES)[number];

/** The manifest's label, so a message names the field the user filled in. */
const ROOT_CERT_LABEL = "Server CA certificate";

export interface TlsConfig {
  readonly host: string;
  readonly encrypt: EncryptMode;
  readonly trustServerCertificate: boolean;
  readonly sslRootCert: string;
}

/** tedious's `encrypt`: `false` still encrypts the login, as every SQL Server client does. */
export function tediousEncrypt(mode: EncryptMode): boolean | "strict" {
  return mode === "strict" ? "strict" : mode === "mandatory";
}

/** Whether the handshake checks the server's certificate against a CA and its name. */
export function verifies(config: TlsConfig): boolean {
  return config.encrypt !== "optional" && !config.trustServerCertificate;
}

/** The CA file's text, read now so a rotated certificate is picked up; undefined when none is set. */
export async function rootCertificate(config: TlsConfig): Promise<string | undefined> {
  const path = config.sslRootCert;
  if (path === "") return undefined;
  let ca: string;
  try {
    ca = await readFile(homeExpanded(path, homedir()), "utf8");
  } catch (cause) {
    throw new TlsSettingsError(tlsFileMessage(ROOT_CERT_LABEL, path, cause), { cause });
  }
  try {
    new X509Certificate(ca);
  } catch (cause) {
    throw new TlsSettingsError(tlsKeyMessage(ROOT_CERT_LABEL, path, cause, false), { cause });
  }
  return ca;
}

/** tedious words a socket failure as `ESOCKET` and keeps the TLS error, with its code, as the cause. */
function socketCause(cause: unknown): unknown {
  return cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
}

/**
 * The error a failed connect throws: a `TlsSettingsError` saying what a verifying handshake did not
 * match, else a plain `connectionFailed` with the driver's message.
 */
export function connectFailure(config: TlsConfig, serverName: string | undefined, cause: unknown): PluginError {
  const message = verifies(config)
    ? tlsFailureMessage(socketCause(cause), {
        caLabel: ROOT_CERT_LABEL,
        caPath: config.sslRootCert === "" ? null : config.sslRootCert,
        host: serverName ?? config.host,
      })
    : null;
  if (message !== null) return new TlsSettingsError(message, { cause });
  return new PluginError("connectionFailed", cause instanceof Error ? cause.message : String(cause), { cause });
}

/** What the handshake agreed on `socket`, or null when it is not TLS. */
export function tlsInfoOf(socket: unknown): TlsInfo | null {
  if (!(socket instanceof TLSSocket)) return null;
  const protocol = socket.getProtocol();
  if (protocol === null) return null;
  const cipher = socket.getCipher();
  return { protocol, cipher: cipher.standardName || cipher.name };
}
