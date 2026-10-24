import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createSecureContext, TLSSocket } from "node:tls";
import type mysql from "mysql2";
import {
  homeExpanded,
  PluginError,
  TlsSettingsError,
  tlsFailureMessage,
  tlsFileMessage,
  tlsKeyIsEncrypted,
  tlsKeyMessage,
  type TlsInfo,
} from "@table-craft/plugin-api";

export const SSL_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;

export type SslMode = (typeof SSL_MODES)[number];

/** The manifest's labels, so a message names the field the user filled in. */
const LABELS = {
  sslRootCert: "SSL root certificate",
  sslCert: "Client certificate",
  sslKey: "Client key",
} as const;

export interface TlsConfig {
  readonly host: string;
  readonly sslMode: SslMode;
  readonly sslRootCert: string;
  readonly sslCert: string;
  readonly sslKey: string;
  readonly sslKeyPassphrase: string;
}

type FileKey = keyof typeof LABELS;

async function readTlsFile(config: TlsConfig, key: FileKey): Promise<string | undefined> {
  const path = config[key];
  if (path === "") return undefined;
  try {
    return await readFile(homeExpanded(path, homedir()), "utf8");
  } catch (cause) {
    throw new TlsSettingsError(tlsFileMessage(LABELS[key], path, cause), { cause });
  }
}

/** Parses each file before the driver sees it, so a bad one is named instead of failing the handshake. */
function checked(config: TlsConfig, key: FileKey, use: () => unknown, encrypted = false): void {
  try {
    use();
  } catch (cause) {
    throw new TlsSettingsError(tlsKeyMessage(LABELS[key], config[key], cause, encrypted), { cause });
  }
}

/**
 * mysql2's `ssl` option, the files read now so a rotated certificate is picked up. mysql2 checks
 * the host name only under `verifyIdentity`, against the `host` it was given.
 */
export async function tlsOptions(config: TlsConfig): Promise<mysql.SslOptions | undefined> {
  if (config.sslMode === "disable") return undefined;
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config, "sslRootCert"),
    readTlsFile(config, "sslCert"),
    readTlsFile(config, "sslKey"),
  ]);
  const passphrase = config.sslKeyPassphrase === "" ? undefined : config.sslKeyPassphrase;
  if (cert !== undefined) checked(config, "sslCert", () => new X509Certificate(cert));
  if (key !== undefined) checked(config, "sslKey", () => createPrivateKey({ key, passphrase }), tlsKeyIsEncrypted(key));
  const files = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(passphrase === undefined ? {} : { passphrase }),
  };
  checked(config, cert === undefined ? "sslKey" : "sslCert", () => createSecureContext(files));
  switch (config.sslMode) {
    case "require":
      return { ...files, rejectUnauthorized: false };
    case "verify-ca":
      return { ...files, rejectUnauthorized: true, verifyIdentity: false };
    case "verify-full":
      return { ...files, rejectUnauthorized: true, verifyIdentity: true };
  }
}

/**
 * The error a failed connect throws: a `TlsSettingsError` saying what a verifying handshake did not
 * match, else a plain `connectionFailed` with the driver's message.
 */
export function connectFailure(config: TlsConfig, serverName: string | undefined, cause: unknown): PluginError {
  const verifying = config.sslMode === "verify-ca" || config.sslMode === "verify-full";
  const message = verifying
    ? tlsFailureMessage(cause, {
        caLabel: LABELS.sslRootCert,
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
