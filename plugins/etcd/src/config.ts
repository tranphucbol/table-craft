import { z } from "@table-craft/plugin-api";
import { TLS_MODES } from "./tls.js";

const DEFAULT_PORT = 2379;
const DEFAULT_SCAN_BATCH = 1000;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
/** etcd's own default request limit is 1.5 MiB; 16 leaves room for wide ranges. */
const DEFAULT_MAX_MESSAGE_MB = 16;

/**
 * One endpoint, `host:port`, which an SSH tunnel can replace (decision 10 of plan 110); the
 * member list still shows every member of the cluster.
 */
export const connectionSchema = z.strictObject({
  host: z.string().min(1).default("localhost"),
  port: z.number().int().positive().default(DEFAULT_PORT),
  user: z.string().default(""),
  password: z.string().default(""),
  keyDelimiter: z.string().default("/"),
  scanBatch: z.number().int().positive().default(DEFAULT_SCAN_BATCH),
  connectTimeout: z.number().positive().default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
  maxMessageMb: z.number().int().positive().default(DEFAULT_MAX_MESSAGE_MB),
  tlsMode: z.enum(TLS_MODES).default("disable"),
  tlsCa: z.string().default(""),
  tlsCert: z.string().default(""),
  tlsKey: z.string().default(""),
  tlsKeyPassphrase: z.string().default(""),
});

export type EtcdConfig = z.infer<typeof connectionSchema>;
