import { z } from "@table-craft/plugin-api";
import { TLS_MODES } from "./tls.js";

const DEFAULT_PORT = 2379;
const DEFAULT_SCAN_BATCH = 1000;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
/** etcd's own default request limit is 1.5 MiB; 16 leaves room for wide ranges. */
const DEFAULT_MAX_MESSAGE_MB = 16;
const MAX_PORT = 65535;
const DEFAULT_MAX_REQUEST_BYTES = 1572864;

export const connectionSchema = z
  .strictObject({
    host: z.string().min(1).default("localhost"),
    port: z.number().int().positive().max(MAX_PORT).default(DEFAULT_PORT),
    endpoints: z
      .string()
      .default("")
      .superRefine((value, context) => {
        try {
          parseEndpoints(value);
        } catch {
          context.addIssue({ code: "custom", message: "Use comma-separated host:port endpoints (bracket IPv6)." });
        }
      }),
    namespace: z.string().default(""),
    namespaceEncoding: z.enum(["utf8", "base64"]).default("utf8"),
    authMode: z.enum(["auto", "none", "password", "clientCN"]).default("auto"),
    user: z.string().default(""),
    password: z.string().default(""),
    keyDelimiter: z.string().default("/"),
    scanBatch: z.number().int().positive().default(DEFAULT_SCAN_BATCH),
    connectTimeout: z.number().positive().default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
    maxMessageMb: z.number().int().positive().default(DEFAULT_MAX_MESSAGE_MB),
    maxRequestBytes: z.number().int().positive().default(DEFAULT_MAX_REQUEST_BYTES),
    requestTimeout: z.number().positive().default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
    readMode: z.enum(["linearizable", "serializable"]).default("linearizable"),
    lockPrefix: z.string().default("/locks/"),
    electionPrefix: z.string().default("/elections/"),
    autoSyncInterval: z.number().nonnegative().default(0),
    serverName: z.string().default(""),
    tlsMode: z.enum(TLS_MODES).default("disable"),
    tlsCa: z.string().default(""),
    tlsCert: z.string().default(""),
    tlsKey: z.string().default(""),
    tlsKeyPassphrase: z.string().default(""),
  })
  .superRefine((value, context) => {
    if (value.authMode === "password" && value.user.trim() === "") {
      context.addIssue({ code: "custom", path: ["user"], message: "Enter the username for password authentication." });
    }
    if (
      value.namespaceEncoding === "base64" &&
      Buffer.from(value.namespace, "base64").toString("base64") !== value.namespace
    ) {
      context.addIssue({ code: "custom", path: ["namespace"], message: "Namespace must be canonical base64." });
    }
    if (value.authMode === "clientCN" && (value.tlsMode === "disable" || value.tlsCert === "" || value.tlsKey === "")) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "Client CN authentication requires TLS and a client certificate and key.",
      });
    }
  });

export type EtcdConfig = z.infer<typeof connectionSchema>;

export interface EtcdEndpoint {
  readonly id: string;
  readonly host: string;
  readonly port: number;
}

function parseEndpoints(value: string): EtcdEndpoint[] {
  if (value.trim() === "") return [];
  const seen = new Set<string>();
  return value.split(/[,\n]/).map((part, index) => {
    const match = /^(?:\[([^\]]+)\]|([^:\s/]+)):(\d+)$/.exec(part.trim());
    const host = match?.[1] ?? match?.[2];
    const port = Number(match?.[3]);
    if (host === undefined || !Number.isInteger(port) || port < 1 || port > MAX_PORT)
      throw new Error("Invalid endpoint");
    const address = `${host}:${String(port)}`;
    if (seen.has(address)) throw new Error("Duplicate endpoint");
    seen.add(address);
    return { id: `endpoint-${String(index + 1)}`, host, port };
  });
}

/** Only explicitly configured endpoints are eligible for dialing, never member advertisements. */
export function connectionEndpoints(config: EtcdConfig): EtcdEndpoint[] {
  const endpoints = parseEndpoints(config.endpoints);
  return endpoints.length === 0 ? [{ id: "primary", host: config.host, port: config.port }] : endpoints;
}

export function namespaceBytes(config: EtcdConfig): Buffer {
  return Buffer.from(config.namespace, config.namespaceEncoding);
}
