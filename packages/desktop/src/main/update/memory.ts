/**
 * What the updater keeps in the profile: the skipped version in `update-state.json`, owned by main
 * alone so it never races the Settings dialog's writes to `settings.json`, and the swap script's
 * output, which the next launch moves into the app log.
 */
import { isVersion } from "@table-craft/desktop/main/update/manifest.js";
import type { UpdateMemory } from "@table-craft/desktop/main/update/updater.js";
import type { Logger } from "@table-craft/desktop/log/record.js";

export const UPDATE_STATE_FILE = "update-state.json";
export const SWAP_LOG_FILE = "update-swap.log";
/** The script's own words for a swap that did not happen; such a line is a warning, not news. */
const SWAP_FAILURE = /nothing was replaced|was restored/;
/** A later swap in the same file succeeded, so an earlier failure is history. */
const SWAP_REPLACED = "replaced; relaunching";

export interface MemoryFiles {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export function readUpdateMemory(text: string | null): UpdateMemory {
  if (text === null) return { skippedVersion: null };
  try {
    const parsed = JSON.parse(text) as { skippedVersion?: unknown };
    return { skippedVersion: isVersion(parsed.skippedVersion) ? parsed.skippedVersion : null };
  } catch {
    return { skippedVersion: null };
  }
}

export function writeUpdateMemory(memory: UpdateMemory): string {
  return `${JSON.stringify(memory, null, 2)}\n`;
}

/** `mv`'s words when App Management, not the file mode, stopped the swap. */
const SWAP_DENIED = /Operation not permitted/;
/** The `date -u` stamp `say` puts before each line. */
const SWAP_TIMESTAMP = /^\S+Z /;

/** Why the last Restart to Update left the old version in place. */
export interface SwapFailure {
  /** The script's own line, without its timestamp. */
  readonly reason: string;
  /** macOS refused the move, so retrying without App Management fails the same way. */
  readonly denied: boolean;
}

/**
 * Appends the last swap's lines to the log and removes the file, so each is logged once. Returns
 * the failure, if the swap gave up, for the updater to tell the user instead of offering the same
 * update again as if nothing happened.
 */
export async function drainSwapLog(path: string, files: MemoryFiles, log: Logger): Promise<SwapFailure | null> {
  const text = await files.readText(path);
  if (text === null) return null;
  let failure: SwapFailure | null = null;
  let denied = false;
  for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) {
    if (SWAP_DENIED.test(line)) denied = true;
    if (SWAP_FAILURE.test(line)) {
      log.warn("swap script", { line });
      failure = { reason: line.replace(SWAP_TIMESTAMP, "").trim(), denied };
    } else {
      log.info("swap script", { line });
      if (line.includes(SWAP_REPLACED)) {
        failure = null;
        denied = false;
      }
    }
  }
  await files.remove(path);
  return failure;
}
