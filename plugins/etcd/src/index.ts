import type { Capability, CommandLanguage, DatasourcePlugin } from "@table-craft/plugin-api";
import { complete, signatureAt } from "./complete.js";
import { connectionSchema } from "./config.js";
import { classify, inspect, split } from "./language.js";
import { EtcdSession } from "./session.js";

const PLUGIN_ID = "etcd";
const CAPABILITIES: readonly Capability[] = ["commands", "keepAlive", "keyValue", "nodes", "serverInfo"];

const commandLanguage: CommandLanguage = { split, classify, complete, signatureAt, inspect };

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  commandLanguage,
  connectionSchema,
  connect: (config, options) => EtcdSession.open(connectionSchema.parse(config), options),
};

export default plugin;
