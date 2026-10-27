import { pickedCompletion, snippet, type CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Transaction, type ChangeSpec } from "@codemirror/state";
import { snippetMatches, type TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

const PLACEHOLDER = /(\\*)\$\{([^{}\r\n]+)\}/g;
const ABBREVIATION = /[A-Za-z_][A-Za-z0-9_]*$/;
const LITERAL_CONTEXT = /String|Comment|QuotedIdentifier/;

/** The text inserted before a user edits any named fields. */
export function snippetPreview(body: string): string {
  return body.replace(PLACEHOLDER, (match: string, slashes: string, name: string) => {
    if (slashes.length % 2 !== 0) return match.slice(1);
    return slashes + (name === "cursor" ? "" : name);
  });
}

/** Translates named fields to ordered native fields without interpreting text or literal braces. */
export function snippetTemplate(
  body: string,
  literal: (text: string) => string = (text) => text.replace(/[{}]/g, "\\$&"),
): string {
  const fields = new Map<string, number>();
  let cursor = false;
  let offset = 0;
  let template = "";
  for (const match of body.matchAll(PLACEHOLDER)) {
    const slashes = match[1]!;
    const name = match[2]!;
    template += literal(body.slice(offset, match.index));
    if (slashes.length % 2 !== 0) {
      template += literal(match[0].slice(1));
    } else if (name === "cursor") {
      template += slashes;
      template += "${0}";
      cursor = true;
    } else {
      template += slashes;
      const order = fields.get(name) ?? fields.size + 1;
      fields.set(name, order);
      template += `\${${String(order)}:${name}}`;
    }
    offset = match.index + match[0].length;
  }
  template += literal(body.slice(offset));
  return cursor ? template : template + "${0}";
}

/** Native parsing mis-maps fields after several escaped braces; equal-width sentinels keep ranges intact. */
export function applySnippet(body: string): ReturnType<typeof snippet> {
  let code = 1;
  const unused = () => {
    while (body.includes(String.fromCharCode(code))) code += 1;
    return String.fromCharCode(code++);
  };
  const open = unused(),
    close = unused();
  const native = snippet(snippetTemplate(body, (text) => text.replaceAll("{", open).replaceAll("}", close)));
  return (view, completion, from, to) => {
    native(
      {
        state: view.state,
        dispatch: (transaction: Transaction) => {
          const changes: ChangeSpec[] = [];
          transaction.changes.iterChanges((start, end, _from, _to, inserted) => {
            changes.push({
              from: start,
              to: end,
              insert: inserted.toString().replaceAll(open, "{").replaceAll(close, "}"),
            });
          });
          view.dispatch(
            view.state.update({
              changes,
              selection: transaction.selection,
              effects: transaction.effects,
              annotations:
                completion === null
                  ? []
                  : [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")],
              scrollIntoView: true,
              // Native apply already ran filters, including Tab's identifier-tail replacement.
              filter: false,
            }),
          );
        },
      },
      completion,
      from,
      to,
    );
  };
}

export interface SnippetTarget {
  readonly snippets: () => readonly TextSnippet[];
  readonly plugin: () =>
    | {
        readonly id: string;
        readonly name?: string;
        readonly capabilities: readonly string[];
        readonly highlight?: string | null;
      }
    | undefined;
}

function scopeLabel(item: TextSnippet, plugin: ReturnType<SnippetTarget["plugin"]>): string {
  switch (item.scope.kind) {
    case "all":
      return "All consoles";
    case "sql":
      return item.scope.highlight === undefined ? "SQL" : `SQL · ${item.scope.highlight}`;
    case "plugin":
      return `${plugin?.name ?? item.scope.pluginId} (${item.scope.pluginId})`;
  }
}

/** Console-only text snippets matched against the active datasource's metadata, even offline. */
export function snippetSource(target: SnippetTarget): CompletionSource {
  return (context) => {
    const plugin = target.plugin();
    if (plugin === undefined) return null;
    for (let node = syntaxTree(context.state).resolveInner(context.pos, -1); node;) {
      if (LITERAL_CONTEXT.test(node.name)) return null;
      if (node.parent === null) break;
      node = node.parent;
    }
    const word = context.matchBefore(ABBREVIATION);
    if (word === null) return null;
    const options = target
      .snippets()
      .filter((item) => snippetMatches(item, plugin))
      .filter((item) => item.prefix.toLowerCase().startsWith(word.text.toLowerCase()))
      .map((item) => ({
        label: item.prefix,
        detail: `${item.name} · ${scopeLabel(item, plugin)}`,
        type: "snippet",
        info: item.body,
        apply: applySnippet(item.body),
      }));
    return options.length === 0 ? null : { from: word.from, to: context.pos, options };
  };
}
