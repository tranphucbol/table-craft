import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { checkServerIdentity, createSecureContext, type PeerCertificate } from "node:tls";
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
const KEY_EXPORT = { type: "pkcs8", format: "pem" } as const;

export interface TlsConfig {
  readonly host: string;
  readonly tlsMode: TlsMode;
  readonly tlsCa: string;
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly tlsKeyPassphrase: string;
}

/**
 * What gRPC's `createSsl` takes: PEM buffers, the key already decrypted since gRPC takes no
 * passphrase, and how the server certificate is checked.
 */
export interface GrpcTls {
  readonly rootCertificate: Buffer | null;
  readonly privateKey: Buffer | null;
  readonly certChain: Buffer | null;
  readonly rejectUnauthorized: boolean;
  readonly checkServerIdentity: (host: string, certificate: PeerCertificate) => Error | undefined;
  /** The name the certificate must carry when it is not the dialled host, such as through a tunnel. */
  readonly serverName: string | null;
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
function checked<T>(config: TlsConfig, key: FileKey, use: () => T, encrypted = false): T {
  try {
    return use();
  } catch (cause) {
    throw new TlsSettingsError(tlsKeyMessage(LABELS[key], config[key], cause, encrypted), { cause });
  }
}

/** The TLS settings for gRPC, the files read now so a rotated certificate is picked up; null without TLS. */
export async function grpcTls(config: TlsConfig, serverName: string | undefined): Promise<GrpcTls | null> {
  if (config.tlsMode === "disable") return null;
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config, "tlsCa"),
    readTlsFile(config, "tlsCert"),
    readTlsFile(config, "tlsKey"),
  ]);
  if ((cert === undefined) !== (key === undefined)) {
    throw new TlsSettingsError(`${LABELS.tlsCert} and ${LABELS.tlsKey} go together: fill in both, or neither.`);
  }
  const passphrase = config.tlsKeyPassphrase === "" ? undefined : config.tlsKeyPassphrase;
  if (cert !== undefined) checked(config, "tlsCert", () => new X509Certificate(cert));
  const privateKey =
    key === undefined
      ? null
      : checked(
          config,
          "tlsKey",
          () => Buffer.from(createPrivateKey({ key, passphrase }).export(KEY_EXPORT)),
          tlsKeyIsEncrypted(key),
        );
  checked(config, cert === undefined ? "tlsKey" : "tlsCert", () =>
    createSecureContext({
      ...(ca === undefined ? {} : { ca }),
      ...(cert === undefined ? {} : { cert }),
      ...(privateKey === null ? {} : { key: privateKey }),
    }),
  );
  const name = serverName ?? config.host;
  const files = {
    rootCertificate: ca === undefined ? null : Buffer.from(ca),
    privateKey,
    certChain: cert === undefined ? null : Buffer.from(cert),
    serverName: serverName ?? null,
  };
  switch (config.tlsMode) {
    case "require":
      return { ...files, rejectUnauthorized: false, checkServerIdentity: () => undefined };
    case "verify-ca":
      return { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return {
        ...files,
        rejectUnauthorized: true,
        checkServerIdentity: (_dialled, certificate) => checkServerIdentity(name, certificate),
      };
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
