import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { Capability, GeneratorStatement } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE, type ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { openDdl } from "@table-craft/desktop/renderer/actions/ddlCommands.js";
import { caretOf, relationOf, resolve, type Caret } from "@table-craft/desktop/renderer/actions/navigationActions.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { selectedRelation } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { caretAnchor } from "@table-craft/desktop/renderer/console/caretAnchor.js";
import { columnNameOf, relationKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import type { QuickDocTarget } from "@table-craft/desktop/renderer/model/quickDoc.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useDdl } from "@table-craft/desktop/renderer/state/ddl.js";
import { parseGeneratorAnswer, useModal, type ModalChoice } from "@table-craft/desktop/renderer/state/modal.js";
import { useQuickDoc } from "@table-craft/desktop/renderer/state/quickDoc.js";
import type { PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";

export const DDL_ACTION_IDS = {
  open: "ddl.open",
  copy: "ddl.copy",
  openInConsole: "ddl.openInConsole",
  refresh: "ddl.refresh",
  quickDoc: "catalog.quickDoc",
  generator: "sql.generator",
} as const;

const GENERATOR_STATEMENTS: readonly (ModalChoice & { readonly id: GeneratorStatement })[] = [
  { id: "create", label: "CREATE" },
  { id: "drop", label: "DROP" },
  { id: "select", label: "SELECT" },
  { id: "insert", label: "INSERT" },
  { id: "update", label: "UPDATE" },
];
const INITIAL_STATEMENT: GeneratorStatement = "select";
const OPEN_IN_CONSOLE = "console";
const COPY = "copy";
const GENERATOR_CHOICES: readonly ModalChoice[] = [
  { id: OPEN_IN_CONSOLE, label: "Open in Console", variant: "primary" },
  { id: COPY, label: "Copy" },
];
const SELECTED_ROW = `[${REGION_ATTRIBUTE}="database"] [role="treeitem"][aria-selected="true"]`;

function capabilitiesOfDatasource(datasourceId: string): readonly Capability[] {
  const { datasources, plugins } = useDatasources.getState();
  const view = datasources.find((datasource) => datasource.id === datasourceId);
  return view === undefined ? [] : capabilitiesOf(plugins, view.pluginId);
}

const canReadDefinition = (context: ActionContext) => {
  const target = selectedRelation(context);
  return target !== null && capabilitiesOfDatasource(target.datasourceId).includes("ddl");
};

const ddlText = (context: ActionContext) => context.ddl?.text ?? null;

/** The relation or column the Database pane's selection is, for Quick Documentation. */
function selectedDocTarget(context: ActionContext): QuickDocTarget | null {
  const { selection } = context;
  if (selection?.kind !== "catalog" || selection.name === null) return null;
  const target = { datasourceId: selection.id, path: selection.path, relation: selection.name };
  const column = columnNameOf(selection.key);
  if (column !== null) return { ...target, column };
  return selection.key === relationKey(selection.id, selection.path, selection.name) ? target : null;
}

/** Quick Documentation asks the tree when focus is not in a console's editor. */
function treeDocTarget(context: ActionContext): QuickDocTarget | null {
  return context.focus === "editor" && caretOf(context) !== null ? null : selectedDocTarget(context);
}

const consoleCanResolve = (context: ActionContext) =>
  caretOf(context) !== null && context.capabilities.includes("sql") && context.capabilities.includes("schemaTree");

function rowAnchor(): PopoverAnchor | null {
  const row = document.querySelector(SELECTED_ROW);
  if (row === null) return null;
  const { left, top, right, bottom } = row.getBoundingClientRect();
  return { left, top, right, bottom };
}

/** What the name at the caret documents: a column, or a relation (an alias standing for its relation). */
async function caretDocTarget(caret: Caret): Promise<QuickDocTarget | null> {
  const declaration = await resolve(caret);
  if (declaration?.kind === "column") {
    const { path, relation, column } = declaration;
    return { datasourceId: caret.datasourceId, path, relation, column };
  }
  const relation = await relationOf(caret, declaration);
  return relation === null
    ? null
    : { datasourceId: caret.datasourceId, path: relation.path, relation: relation.relation };
}

export const DDL_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: DDL_ACTION_IDS.open,
    title: "Go to DDL",
    category: "Navigation",
    icon: "ddl",
    shortcut: "Mod+B",
    shortcutRegion: "database",
    when: canReadDefinition,
    run: async (context) => {
      const target = selectedRelation(context);
      if (target !== null) await openDdl(target);
    },
  }),
  defineAction({
    id: DDL_ACTION_IDS.refresh,
    title: "Refresh DDL",
    category: "Database",
    icon: "synchronize",
    tabKind: "ddl",
    when: (context) => context.ddl !== null && !context.ddl.loading,
    run: async (context) => {
      if (context.activeTab?.kind === "ddl") await useDdl.getState().refresh(context.activeTab.id);
    },
  }),
  defineAction({
    id: DDL_ACTION_IDS.copy,
    title: "Copy DDL",
    category: "Database",
    icon: "copy",
    tabKind: "ddl",
    when: (context) => ddlText(context) !== null,
    run: async (context) => {
      const text = ddlText(context);
      if (text !== null) await writeClipboard(text);
    },
  }),
  defineAction({
    id: DDL_ACTION_IDS.openInConsole,
    title: "Open DDL in Console",
    category: "Database",
    icon: "newConsole",
    tabKind: "ddl",
    when: (context) => ddlText(context) !== null,
    run: async (context) => {
      const text = ddlText(context);
      if (context.ddl !== null && text !== null) await openConsole(context.ddl.datasourceId, text);
    },
  }),
  defineAction({
    id: DDL_ACTION_IDS.quickDoc,
    title: "Quick Documentation",
    category: "Navigation",
    icon: "quickDoc",
    shortcut: "F1",
    shortcutRegion: ["database", "editor"],
    when: (context) => treeDocTarget(context) !== null || consoleCanResolve(context),
    run: async (context) => {
      const fromTree = treeDocTarget(context);
      if (fromTree !== null) {
        const anchor = rowAnchor();
        if (anchor !== null) useQuickDoc.getState().show(fromTree, anchor);
        return;
      }
      const caret = caretOf(context);
      if (caret === null) return;
      const target = await caretDocTarget(caret);
      const anchor = caretAnchor(caret.consoleId, caret.offset);
      if (target === null || anchor === null) return;
      await useCatalog.getState().ensureDescribed(target.datasourceId, target.path);
      useQuickDoc.getState().show(target, anchor);
    },
  }),
  defineAction({
    id: DDL_ACTION_IDS.generator,
    title: "SQL Generator…",
    category: "Database",
    icon: "generate",
    shortcut: "Mod+Alt+G",
    shortcutRegion: "database",
    when: (context) => selectedRelation(context) !== null,
    run: async (context) => {
      const target = selectedRelation(context);
      if (target === null) return;
      const { datasourceId, path, relation } = target;
      const datasources = useDatasources.getState();
      const view = datasources.datasources.find((datasource) => datasource.id === datasourceId);
      const canDefine = capabilitiesOfDatasource(datasourceId).includes("ddl");
      const texts = new Map<string, string>();
      const answer = await useModal.getState().ask({
        kind: "generator",
        title: `SQL Generator: ${relation}`,
        statements: GENERATOR_STATEMENTS.filter((statement) => canDefine || statement.id !== "create"),
        initial: INITIAL_STATEMENT,
        highlight: pluginOf(datasources.plugins, view?.pluginId ?? "")?.highlight,
        generate: async (statement) => {
          const known = GENERATOR_STATEMENTS.find((candidate) => candidate.id === statement);
          if (known === undefined) throw new Error(`There is no ${statement} statement to generate.`);
          const client = await useDatasources.getState().connect(datasourceId);
          const text = await client.call("sql.generate", { path, name: relation, statement: known.id });
          texts.set(statement, text);
          return text;
        },
        choices: GENERATOR_CHOICES,
      });
      if (answer === null) return;
      const { choice, statement } = parseGeneratorAnswer(answer);
      const text = texts.get(statement);
      if (text === undefined) return;
      if (choice === COPY) await writeClipboard(text);
      else await openConsole(datasourceId, text);
    },
  }),
];
