import type { rm } from "node:fs/promises";
import { createRequire } from "node:module";

/** Electron's `fs` without its asar patch, which reads a bundle's `app.asar` as a directory it cannot delete. */
const ORIGINAL_FS = "original-fs";

/** The updater's `remove` in Electron main; resolvable only there, so it loads on first use. */
export function removeTree(path: string): Promise<void> {
  const unpatched = createRequire(import.meta.url)(ORIGINAL_FS) as { readonly promises: { readonly rm: typeof rm } };
  return unpatched.promises.rm(path, { recursive: true, force: true });
}
