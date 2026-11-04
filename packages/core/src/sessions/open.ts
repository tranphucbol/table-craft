import { serviceProblems, type ConnectOptions, type Session } from "@table-craft/plugin-api";
import { CoreError } from "@table-craft/core/errors.js";
import type { LoadedPlugin, PluginLoadResult } from "@table-craft/core/plugins/loader.js";

const BROKEN_SESSION_HINT = "Update the plugin, or report the problem to its author.";

/** The loaded plugin with `pluginId`; rejects with `pluginUnavailable` or `unknownPlugin` otherwise. */
export function loadedPlugin(plugins: readonly PluginLoadResult[], pluginId: string): LoadedPlugin {
  const candidates = plugins.filter((entry) => entry.manifest?.id === pluginId);
  const loaded = candidates.find((entry) => entry.status === "loaded");
  if (loaded === undefined) {
    const unavailable = candidates.find((entry) => entry.status === "unavailable");
    if (unavailable !== undefined) {
      throw new CoreError(
        "pluginUnavailable",
        `Plugin "${pluginId}" is unavailable: ${unavailable.reason}`,
        `Fix the plugin in ${unavailable.directory} and restart.`,
      );
    }
    throw new CoreError(
      "unknownPlugin",
      `No plugin with id "${pluginId}" is installed.`,
      "Install the plugin, or pick a datasource type that is installed.",
    );
  }
  return loaded;
}

/**
 * Connects through the loaded plugin with `pluginId`, validating `config` against its schema first.
 * A session whose services differ from the plugin's capabilities is closed and refused, so nothing
 * downstream meets a capability without its service (decision 155).
 */
export async function openSession(
  plugins: readonly PluginLoadResult[],
  pluginId: string,
  config: unknown,
  options: ConnectOptions,
): Promise<Session> {
  const loaded = loadedPlugin(plugins, pluginId);
  const parsed = loaded.plugin.connectionSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new CoreError(
      "invalidConfig",
      `The connection settings are invalid: ${issues.join("; ")}`,
      "Correct the datasource settings and connect again.",
    );
  }
  const session = await loaded.plugin.connect(parsed.data, options);
  const problems = serviceProblems(loaded.plugin.capabilities, loaded.plugin, session);
  if (problems.length === 0) return session;
  await session.close().catch(() => undefined);
  throw new CoreError(
    "pluginUnavailable",
    `Plugin "${pluginId}" is unavailable: it ${problems.map((problem) => problem.message).join("; ")}.`,
    BROKEN_SESSION_HINT,
  );
}
