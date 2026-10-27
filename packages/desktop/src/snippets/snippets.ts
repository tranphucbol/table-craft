export type SnippetScope =
  | { readonly kind: "all" }
  | { readonly kind: "sql"; readonly highlight?: string }
  | { readonly kind: "plugin"; readonly pluginId: string };

export interface TextSnippet {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly body: string;
  readonly scope: SnippetScope;
}

export const SNIPPET_ID_MAX_LENGTH = 128;
export const SNIPPET_NAME_MAX_LENGTH = 120;
export const SNIPPET_PREFIX_MAX_LENGTH = 64;
export const SNIPPET_BODY_MAX_LENGTH = 100_000;
export const SNIPPET_SCOPE_VALUE_MAX_LENGTH = 128;
export const SNIPPET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SNIPPET_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function snippetProblem(snippet: TextSnippet): string | null {
  if (!SNIPPET_ID_PATTERN.test(snippet.id) || snippet.id.length > SNIPPET_ID_MAX_LENGTH)
    return `Snippet ID must contain only letters, numbers, underscores or hyphens and be at most ${String(SNIPPET_ID_MAX_LENGTH)} characters.`;
  if (!snippet.name.trim() || snippet.name.length > SNIPPET_NAME_MAX_LENGTH)
    return `Enter a snippet name of at most ${String(SNIPPET_NAME_MAX_LENGTH)} characters.`;
  if (!SNIPPET_PREFIX_PATTERN.test(snippet.prefix) || snippet.prefix.length > SNIPPET_PREFIX_MAX_LENGTH)
    return `Enter a prefix starting with a letter or underscore, followed by letters, numbers or underscores (at most ${String(SNIPPET_PREFIX_MAX_LENGTH)} characters).`;
  if (!snippet.body.trim() || snippet.body.length > SNIPPET_BODY_MAX_LENGTH)
    return `Enter snippet text of at most ${String(SNIPPET_BODY_MAX_LENGTH)} characters.`;
  const scopeValue =
    snippet.scope.kind === "plugin"
      ? snippet.scope.pluginId
      : snippet.scope.kind === "sql"
        ? snippet.scope.highlight
        : undefined;
  if (scopeValue !== undefined && (!scopeValue.trim() || scopeValue.length > SNIPPET_SCOPE_VALUE_MAX_LENGTH))
    return `Choose a scope identifier of at most ${String(SNIPPET_SCOPE_VALUE_MAX_LENGTH)} characters.`;
  return null;
}

export function snippetScopeKey(scope: SnippetScope): string {
  switch (scope.kind) {
    case "all":
      return JSON.stringify(["all"]);
    case "sql":
      return JSON.stringify(["sql", scope.highlight ?? null]);
    case "plugin":
      return JSON.stringify(["plugin", scope.pluginId]);
  }
}

export interface SnippetTarget {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly highlight?: string | null;
}

export function snippetMatches(snippet: TextSnippet, target: SnippetTarget | undefined): boolean {
  if (target === undefined || (!target.capabilities.includes("sql") && !target.capabilities.includes("commands")))
    return false;
  switch (snippet.scope.kind) {
    case "all":
      return true;
    case "sql":
      return (
        target.capabilities.includes("sql") &&
        (snippet.scope.highlight === undefined || snippet.scope.highlight === target.highlight)
      );
    case "plugin":
      return snippet.scope.pluginId === target.id;
  }
}
