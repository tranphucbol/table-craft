import { definePlugin, type CommandLanguage } from "@table-craft/plugin-api";
import { complete, signatureAt } from "./complete.js";
import { connectionSchema } from "./config.js";
import { classify, inspect, split } from "./language.js";
import { CAPABILITIES, RedisSession } from "./session.js";

const PLUGIN_ID = "redis";

const commandLanguage: CommandLanguage = { split, classify, complete, signatureAt, inspect };

export default definePlugin({
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  commandLanguage,
  connectionSchema,
  connect: (config, options) => RedisSession.open(connectionSchema.parse(config), options),
});
