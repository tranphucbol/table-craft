import { join } from "node:path";
import { z } from "@table-craft/plugin-api";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";
import {
  snippetProblem,
  snippetScopeKey,
  SNIPPET_ID_MAX_LENGTH,
  SNIPPET_ID_PATTERN,
  type TextSnippet,
} from "@table-craft/desktop/snippets/snippets.js";

export const SNIPPETS_FILE = "snippets.json";
const SNIPPETS_VERSION = 2;
const JSON_INDENT = 2;

export const snippetIdSchema = z.string().max(SNIPPET_ID_MAX_LENGTH).regex(SNIPPET_ID_PATTERN);
const snippetScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("sql"), highlight: z.string().optional() }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: z.string() }),
]);
export const snippetSchema = z
  .strictObject({
    id: snippetIdSchema,
    name: z.string(),
    prefix: z.string(),
    body: z.string(),
    scope: snippetScopeSchema,
  })
  .superRefine((snippet, context) => {
    const problem = snippetProblem(snippet);
    if (problem !== null) context.addIssue({ code: "custom", message: problem });
  }) satisfies z.ZodType<TextSnippet>;

const envelopeSchema = z.strictObject({ version: z.literal(SNIPPETS_VERSION), snippets: z.array(snippetSchema) });
const legacyEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  snippets: z.array(
    z.strictObject({
      id: snippetIdSchema,
      name: z.string(),
      prefix: z.string(),
      body: z.string(),
      dialect: z.string().nullable(),
    }),
  ),
});

function readDocument(json: unknown): readonly TextSnippet[] {
  const legacy = legacyEnvelopeSchema.safeParse(json);
  if (!legacy.success) return envelopeSchema.parse(json).snippets;
  return legacy.data.snippets.map(({ dialect, ...snippet }) =>
    snippetSchema.parse({
      ...snippet,
      scope: dialect === null ? { kind: "sql" } : { kind: "sql", highlight: dialect },
    }),
  );
}

export class SnippetError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "SnippetError";
  }
}

export interface SnippetsService {
  read(): Promise<readonly TextSnippet[]>;
  save(snippet: TextSnippet): Promise<readonly TextSnippet[]>;
  remove(id: string): Promise<readonly TextSnippet[]>;
}

export interface SnippetsServiceOptions {
  readonly directory: string;
  readonly files: FileSystem;
  readonly onChanged: (snippets: readonly TextSnippet[]) => void;
}

function collectionProblem(snippets: readonly TextSnippet[]): string | null {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const snippet of snippets) {
    if (ids.has(snippet.id)) return "Snippet IDs must be unique.";
    ids.add(snippet.id);
    const key = JSON.stringify([snippetScopeKey(snippet.scope), snippet.prefix.toLowerCase()]);
    if (prefixes.has(key)) return "A snippet already uses this prefix in the same scope. Choose another prefix.";
    prefixes.add(key);
  }
  return null;
}

export function createSnippetsService(options: SnippetsServiceOptions): SnippetsService {
  const path = join(options.directory, SNIPPETS_FILE);
  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run);
    pending = result.catch(() => undefined);
    return result;
  }
  async function read(): Promise<readonly TextSnippet[]> {
    try {
      const text = await options.files.readText(path);
      if (text === null) return [];
      const snippets = readDocument(JSON.parse(text));
      const problem = collectionProblem(snippets);
      if (problem !== null) throw new Error(problem);
      return snippets;
    } catch (cause) {
      throw new SnippetError(
        `Could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        "Check the file's permissions and version 1 or 2 snippet document, then retry. The file has not been changed.",
      );
    }
  }
  async function write(snippets: readonly TextSnippet[]): Promise<readonly TextSnippet[]> {
    const problem = collectionProblem(snippets);
    if (problem !== null) throw new SnippetError(problem, "Edit the snippet and try again.");
    try {
      await writeAtomically(
        options.files,
        path,
        `${JSON.stringify({ version: SNIPPETS_VERSION, snippets }, null, JSON_INDENT)}\n`,
      );
    } catch (cause) {
      throw new SnippetError(
        `Could not save ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        "Check available disk space and write permissions, then retry. The previous snippets file has been preserved.",
      );
    }
    options.onChanged(snippets);
    return snippets;
  }
  return {
    read: () => serialized(read),
    save(snippet) {
      const parsed = snippetSchema.safeParse(snippet);
      if (!parsed.success)
        return Promise.reject(new SnippetError(parsed.error.message, "Edit the snippet and try again."));
      return serialized(async () => {
        const current = await read();
        const exists = current.some((item) => item.id === parsed.data.id);
        return write(
          exists ? current.map((item) => (item.id === parsed.data.id ? parsed.data : item)) : [...current, parsed.data],
        );
      });
    },
    remove(id) {
      if (!snippetIdSchema.safeParse(id).success)
        return Promise.reject(new SnippetError("Invalid snippet ID.", "Select a saved snippet and try again."));
      return serialized(async () => {
        const current = await read();
        if (!current.some((item) => item.id === id))
          throw new SnippetError("This snippet no longer exists.", "Reload the snippets and select one again.");
        return write(current.filter((item) => item.id !== id));
      });
    },
  };
}
