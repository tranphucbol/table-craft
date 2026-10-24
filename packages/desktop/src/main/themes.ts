import { join } from "node:path";
import { z } from "@table-craft/plugin-api";
import type { DirectoryFileSystem } from "@table-craft/desktop/main/consoleFiles.js";
import {
  BUNDLED_THEMES,
  DARK_COLORS,
  isBundledThemeId,
  isHexColor,
  overrideColors,
  userThemeId,
  type BundledThemeId,
  type UserThemeEntry,
} from "@table-craft/desktop/appearance/themes.js";

export const THEMES_DIRECTORY = "themes";
const THEME_EXTENSION = ".json";
/** Enough for every theme anyone keeps; a folder of thousands is a mistake, not a library. */
export const MAX_THEME_FILES = 64;
/** A complete theme is about 2 KiB; anything this large is not a theme. */
export const MAX_THEME_BYTES = 64 * 1024;
const MAX_THEME_NAME_LENGTH = 64;

const color = z.string().refine(isHexColor, { message: "Use a #rgb, #rrggbb or #rrggbbaa colour." });

function colorsOf(keys: readonly string[]) {
  return z.strictObject(Object.fromEntries(keys.map((key) => [key, color.optional()])));
}

const { syntax, datasource, ...flatColors } = DARK_COLORS;

const themeFileSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_THEME_NAME_LENGTH),
  base: z.string().superRefine((base, context) => {
    if (isBundledThemeId(base)) return;
    context.addIssue({
      code: "custom",
      message: `"${base}" is not a bundled theme; use the id of one listed in Settings, such as "dark" or "gruvbox-dark".`,
    });
  }),
  colors: colorsOf(Object.keys(flatColors))
    .extend({
      syntax: colorsOf(Object.keys(syntax)).optional(),
      datasource: colorsOf(Object.keys(datasource)).optional(),
    })
    .default({}),
});

function stemOf(file: string): string {
  return file.slice(0, -THEME_EXTENSION.length);
}

/** One file's theme, resolved over its base, or the reasons it is not one. */
export function readThemeFile(file: string, text: string): UserThemeEntry {
  const id = userThemeId(stemOf(file));
  if (Buffer.byteLength(text) > MAX_THEME_BYTES) {
    return { id, file, errors: [`The file is larger than ${String(MAX_THEME_BYTES / 1024)} KiB.`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return { id, file, errors: [`Not JSON: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  const parsed = themeFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      id,
      file,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const base = parsed.data.base as BundledThemeId;
  return {
    id,
    name: parsed.data.name,
    base,
    colors: overrideColors(BUNDLED_THEMES[base].colors, parsed.data.colors),
  };
}

export interface ThemeFolder {
  readonly path: string;
  list(): Promise<readonly UserThemeEntry[]>;
}

/** `<userData>/themes/*.json`, read when asked; nothing watches the folder (decision 032). */
export function createThemeFolder(options: { directory: string; files: DirectoryFileSystem }): ThemeFolder {
  const path = join(options.directory, THEMES_DIRECTORY);
  return {
    path,
    async list() {
      const names = (await options.files.listNames(path))
        .filter((name) => name.toLowerCase().endsWith(THEME_EXTENSION) && name.length > THEME_EXTENSION.length)
        .sort((a, b) => a.localeCompare(b));
      return Promise.all(
        names.map(async (file, index): Promise<UserThemeEntry> => {
          if (index >= MAX_THEME_FILES) {
            return {
              id: userThemeId(stemOf(file)),
              file,
              errors: [`Only the first ${String(MAX_THEME_FILES)} theme files are read.`],
            };
          }
          const unreadable = (reason: string): UserThemeEntry => ({
            id: userThemeId(stemOf(file)),
            file,
            errors: [reason],
          });
          try {
            const text = await options.files.readText(join(path, file));
            return text === null ? unreadable("The file could not be found.") : readThemeFile(file, text);
          } catch (cause) {
            return unreadable(`The file could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }),
      );
    },
  };
}
