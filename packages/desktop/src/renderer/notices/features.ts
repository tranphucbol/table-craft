import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "custom-shortcuts",
    title: "Change keyboard shortcuts",
    body: "Rebind any action, or find one by pressing its keys, in Settings › Keymap.",
    action: { label: "Open Keymap", actionId: SETTINGS_ACTION_IDS.show, args: { page: "keymap" } },
  },
  {
    id: "beta-channel",
    title: "Get beta versions",
    body: "Try new features before they are released, from Settings › Advanced.",
    action: { label: "Open Settings", actionId: SETTINGS_ACTION_IDS.show, args: { page: "advanced" } },
  },
  {
    id: "mcp-server",
    title: "Let AI agents use your databases",
    body: "The MCP server lets agents read and, with your approval, change data.",
    action: { label: "MCP Server Settings", actionId: MCP_ACTION_IDS.settings },
  },
  {
    id: "optional-plugins",
    title: "More databases on demand",
    body: "PostgreSQL, Oracle, SQL Server, Redis and etcd download when you first need them.",
    action: { label: "Plugins", actionId: SETTINGS_ACTION_IDS.show, args: { page: "plugins" } },
  },
  {
    id: "duckdb",
    title: "Query Parquet and CSV files with DuckDB",
    body: "Open a DuckDB database, or a Parquet or zstd CSV file, as a data source.",
    action: { label: "New Data Source", actionId: ACTION_IDS.newDatasource },
  },
];
