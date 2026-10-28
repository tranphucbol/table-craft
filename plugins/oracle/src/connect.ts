import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import oracledb from "oracledb";
import {
  homeExpanded,
  PluginError,
  TlsSettingsError,
  tlsFailureMessage,
  tlsFileMessage,
  z,
} from "@table-craft/plugin-api";

export const CONNECT_BY = ["serviceName", "sid"] as const;
export const ROLES = ["none", "SYSDBA", "SYSOPER", "SYSBACKUP"] as const;
/**
 * Thin mode always verifies the server's certificate chain (`rejectUnauthorized`), so there is no
 * `require` that encrypts without checking: `verify-ca` skips only the host-name match.
 */
export const SSL_MODES = ["disable", "verify-ca", "verify-full"] as const;

const DEFAULT_PORT = 1521;
const MAX_PORT = 65_535;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MAX_CONNECT_TIMEOUT_SECONDS = 3600;
const APPLICATION_NAME = "TableCraft";
const MS_PER_MINUTE = 60_000;
const CA_LABEL = "SSL root certificate";

export const connectionSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  connectBy: z.enum(CONNECT_BY).default("serviceName"),
  /** The service name, or the SID when `connectBy` is `sid`. */
  service: z.string().min(1),
  user: z.string().min(1),
  password: z.string().default(""),
  role: z.enum(ROLES).default("none"),
  sslMode: z.enum(SSL_MODES).default("disable"),
  /** A PEM file of the CA that signed the listener's certificate, read at connect (decision 072). */
  sslRootCert: z.string().default(""),
  connectTimeout: z.number().int().min(1).max(MAX_CONNECT_TIMEOUT_SECONDS).default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
  applicationName: z.string().default(APPLICATION_NAME),
});

export type OracleConfig = z.output<typeof connectionSchema>;

/** Characters that would end or open a clause of the descriptor; Oracle names never hold them. */
const DESCRIPTOR_SPECIAL = /[()=]/;

function descriptorValue(value: string, label: string): string {
  if (DESCRIPTOR_SPECIAL.test(value)) {
    throw new PluginError("connectionFailed", `The ${label} "${value}" holds "(", ")" or "="; check it.`);
  }
  return value;
}

/** A full descriptor rather than Easy Connect, so a SID and TCPS are spelled the same way. */
export function connectDescriptor(config: OracleConfig): string {
  const protocol = config.sslMode === "disable" ? "TCP" : "TCPS";
  const host = descriptorValue(config.host, "host");
  const service = descriptorValue(config.service, config.connectBy === "sid" ? "SID" : "service name");
  const target = config.connectBy === "sid" ? `(SID=${service})` : `(SERVICE_NAME=${service})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${host})(PORT=${String(config.port)}))(CONNECT_DATA=${target}))`;
}

const PRIVILEGES: Readonly<Record<Exclude<OracleConfig["role"], "none">, () => number>> = {
  SYSDBA: () => oracledb.SYSDBA,
  SYSOPER: () => oracledb.SYSOPER,
  SYSBACKUP: () => oracledb.SYSBACKUP,
};

async function caContent(config: OracleConfig): Promise<string | undefined> {
  if (config.sslMode === "disable" || config.sslRootCert === "") return undefined;
  try {
    return await readFile(homeExpanded(config.sslRootCert, homedir()), "utf8");
  } catch (cause) {
    throw new TlsSettingsError(tlsFileMessage(CA_LABEL, config.sslRootCert, cause), { cause });
  }
}

export interface OpenOptions {
  readonly keepAliveInitialDelayMs?: number | undefined;
}

/** The driver's connect attributes for `config`, the CA file read now so a rotated one is picked up. */
export async function connectAttributes(
  config: OracleConfig,
  options: OpenOptions,
): Promise<oracledb.ConnectionAttributes> {
  const wallet = await caContent(config);
  const { keepAliveInitialDelayMs } = options;
  return {
    user: config.user,
    password: config.password,
    connectString: connectDescriptor(config),
    connectTimeout: config.connectTimeout,
    ...(config.role === "none" ? {} : { privilege: PRIVILEGES[config.role]() }),
    ...(keepAliveInitialDelayMs === undefined
      ? {}
      : { expireTime: Math.max(1, Math.round(keepAliveInitialDelayMs / MS_PER_MINUTE)) }),
    ...(config.sslMode === "disable"
      ? {}
      : {
          sslServerDNMatch: config.sslMode === "verify-full",
          ...(wallet === undefined ? {} : { walletContent: wallet }),
        }),
    ...(config.applicationName === "" ? {} : { program: config.applicationName }),
  };
}

/** `NJS-138`: thin mode reached a server older than 12.1, which it cannot speak to. */
const OLD_SERVER = "NJS-138";
const OLD_SERVER_MESSAGE = "TableCraft connects to Oracle 12.1 or later; this server is 11.x or older.";
/** Every driver and server message ends with a link to the error's help page. */
const HELP_SUFFIX = /\nHelp: \S+\s*$/;

export function messageOf(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(HELP_SUFFIX, "");
}

/** The error a failed connect throws: TLS problems and too-old servers say what to do next. */
export function connectFailure(config: OracleConfig, cause: unknown): PluginError {
  if (cause instanceof PluginError) return cause;
  const message = messageOf(cause);
  if (message.startsWith(OLD_SERVER)) return new PluginError("connectionFailed", OLD_SERVER_MESSAGE, { cause });
  if (config.sslMode !== "disable") {
    const tls = tlsFailureMessage(cause, {
      caLabel: CA_LABEL,
      caPath: config.sslRootCert === "" ? null : config.sslRootCert,
      host: config.host,
    });
    if (tls !== null) return new TlsSettingsError(tls, { cause });
  }
  return new PluginError("connectionFailed", message, { cause });
}

/** Opens one connection in thin mode; the thick client library is never loaded (decision 102). */
export async function openConnection(config: OracleConfig, options: OpenOptions): Promise<oracledb.Connection> {
  try {
    return await oracledb.getConnection(await connectAttributes(config, options));
  } catch (cause) {
    throw connectFailure(config, cause);
  }
}
