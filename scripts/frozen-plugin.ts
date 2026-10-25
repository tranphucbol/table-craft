/**
 * Builds the SQLite plugin and freezes the bundle as `test/support/frozen-plugins/sqlite-<API_VERSION>/`
 * (decision 107): every later `bun run test` runs the current contract against it, so a change that
 * breaks a plugin built for this version fails. Run it only when the frozen version itself changes,
 * never to make a failing frozen run pass: `bun scripts/frozen-plugin.ts`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION, MANIFEST_FILE } from "@table-craft/plugin-api";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const PLUGIN_ID = "sqlite";
const BUILT = join(DESKTOP, "dist", "resources", "plugins", PLUGIN_ID);
const ENTRY_FILE = "index.js";
/** The map stays behind (1.2 MB), so the bundle must not point at it. */
const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=\S+\s*$/;
export const FROZEN_PLUGINS_DIRECTORY = join(ROOT, "test", "support", "frozen-plugins");

function freeze(): string {
  execFileSync("bunx", ["vite", "build", "--config", "vite.plugins.config.ts", "--mode", PLUGIN_ID], {
    cwd: DESKTOP,
    stdio: "inherit",
  });
  const target = join(FROZEN_PLUGINS_DIRECTORY, `${PLUGIN_ID}-${API_VERSION}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  copyFileSync(join(BUILT, MANIFEST_FILE), join(target, MANIFEST_FILE));
  const bundle = readFileSync(join(BUILT, ENTRY_FILE), "utf8").replace(SOURCE_MAP_COMMENT, "");
  writeFileSync(join(target, ENTRY_FILE), bundle);
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`froze ${freeze()}`);
