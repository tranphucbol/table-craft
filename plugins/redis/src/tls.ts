import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { checkServerIdentity, createSecureContext, type ConnectionOptions } from "node:tls";
import {
  homeExpanded,
  PluginError,
  TlsSettingsError,
  tlsFailureMessage,
  tlsFileMessage,
  tlsKeyIsEncrypted,
  tlsKeyMessage,
} from "@table-craft/plugin-api";

export const TLS_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;

export type TlsMode = (typeof TLS_MODES)[number];

/** The manifest's labels, so a message names the field the user filled in. */
const LABELS = {
  tlsCa: "CA certificate",
  tlsCert: "Client certificate",
  tlsKey: "Client key",
} as const;

export interface TlsConfig {
  readonly host: string;
  readonly tlsMode: TlsMode;
  readonly tlsCa: string;
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly tlsKeyPassphrase: string;
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

/** The TLS options for `tls.connect`, the files read now so a rotated certificate is picked up. */
export async function tlsOptions(
  config: TlsConfig,
  serverName: string | undefined,
): Promise<ConnectionOptions | false> {
  if (config.tlsMode === "disable") return false;
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config, "tlsCa"),
    readTlsFile(config, "tlsCert"),
    readTlsFile(config, "tlsKey"),
  ]);
  const passphrase = config.tlsKeyPassphrase === "" ? undefined : config.tlsKeyPassphrase;
  if (cert !== undefined) checked(config, "tlsCert", () => new X509Certificate(cert));
  if (key !== undefined) checked(config, "tlsKey", () => createPrivateKey({ key, passphrase }), tlsKeyIsEncrypted(key));
  const files = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(passphrase === undefined ? {} : { passphrase }),
  };
  checked(config, cert === undefined ? "tlsKey" : "tlsCert", () => createSecureContext(files));
  switch (config.tlsMode) {
    case "require":
      return { ...files, rejectUnauthorized: false };
    case "verify-ca":
      return { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full": {
      const name = serverName ?? config.host;
      return {
        ...files,
        rejectUnauthorized: true,
        ...(isIP(name) === 0 ? { servername: name } : {}),
        checkServerIdentity: (_dialled, certificate) => checkServerIdentity(name, certificate),
      };
    }
  }
}

/**
 * The error a failed connect throws: a `TlsSettingsError` saying what a verifying handshake did not
 * match, else a plain `connectionFailed` with the driver's message.
 */
export function connectFailure(config: TlsConfig, serverName: string | undefined, cause: unknown): PluginError {
  const verifying = config.tlsMode === "verify-ca" || config.tlsMode === "verify-full";
  const message = verifying
    ? tlsFailureMessage(cause, {
        caLabel: LABELS.tlsCa,
        caPath: config.tlsCa === "" ? null : config.tlsCa,
        host: serverName ?? config.host,
      })
    : null;
  if (message !== null) return new TlsSettingsError(message, { cause });
  return new PluginError("connectionFailed", cause instanceof Error ? cause.message : String(cause), { cause });
}
