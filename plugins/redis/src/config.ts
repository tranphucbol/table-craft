import { z } from "@table-craft/plugin-api";
import { TLS_MODES } from "./tls.js";

export const MODES = ["standalone", "sentinel", "cluster"] as const;

const DEFAULT_PORT = 6379;
const DEFAULT_SCAN_BATCH = 1000;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
/** The master name of Redis's sample `sentinel.conf`. */
const DEFAULT_MASTER_NAME = "mymaster";

/**
 * One flat object, `mode` choosing which fields apply (decision 2 of plan 058): the form hides
 * `database` in cluster mode, `nodeAddressMap` in standalone mode and the Sentinel fields outside
 * sentinel mode through `visibleWhen`, and the host's form checks read a flat schema's properties.
 */
export const connectionSchema = z.strictObject({
  mode: z.enum(MODES).default("standalone"),
  host: z.string().min(1).default("localhost"),
  port: z.number().int().positive().default(DEFAULT_PORT),
  user: z.string().default(""),
  password: z.string().default(""),
  masterName: z.string().min(1).default(DEFAULT_MASTER_NAME),
  sentinels: z.string().default(""),
  sentinelUser: z.string().default(""),
  sentinelPassword: z.string().default(""),
  database: z.number().int().min(0).default(0),
  nodeAddressMap: z.string().default(""),
  clientName: z.string().default("TableCraft"),
  keyDelimiter: z.string().default(":"),
  scanBatch: z.number().int().positive().default(DEFAULT_SCAN_BATCH),
  connectTimeout: z.number().positive().default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
  tlsMode: z.enum(TLS_MODES).default("disable"),
  tlsCa: z.string().default(""),
  tlsCert: z.string().default(""),
  tlsKey: z.string().default(""),
  tlsKeyPassphrase: z.string().default(""),
});

export type RedisConfig = z.infer<typeof connectionSchema>;
