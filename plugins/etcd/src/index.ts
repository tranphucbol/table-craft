import type { Capability, CommandLanguage, DatasourcePlugin } from "@table-craft/plugin-api";
import { complete, signatureAt } from "./complete.js";
import { connectionEndpoints, connectionSchema } from "./config.js";
import { admitConsoleCommand, classify, inspect, split } from "./language.js";
import { EtcdSession } from "./session.js";
import { transactionBuilder } from "./transactionBuilder.js";

const PLUGIN_ID = "etcd";
const CAPABILITIES: readonly Capability[] = [
  "commands",
  "keepAlive",
  "keyValue",
  "nodes",
  "serverInfo",
  "revisions",
  "watch",
  "leases",
  "access",
  "members",
  "maintenance",
  "coordination",
  "bulkTransfer",
];

const commandLanguage: CommandLanguage = {
  split,
  classify,
  complete,
  signatureAt,
  inspect,
  transactionBuilder,
  admit: admitConsoleCommand,
};

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  commandLanguage,
  connectionSchema,
  connectionEndpoints: (config) => connectionEndpoints(connectionSchema.parse(config)),
  connect: (config, options) => EtcdSession.open(connectionSchema.parse(config), options),
};

export default plugin;
