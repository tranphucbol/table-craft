import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { MAX_PASTED_BYTES, type ImportPreviewRequest } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { isEmptySelection, selectionOf } from "@table-craft/desktop/renderer/model/exportDataSources.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { useDataSourcesDialog } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { useExportDataSourcesDialog } from "@table-craft/desktop/renderer/state/exportDataSourcesDialog.js";
import { useImportDataSourcesDialog } from "@table-craft/desktop/renderer/state/importDataSourcesDialog.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";

export const DATASOURCE_FILE_ACTION_IDS = {
  exportDatasources: "datasource.export",
  copyDatasources: "datasource.copy",
  pasteDatasources: "datasource.paste",
} as const;

const NOTHING_TO_PASTE = "The clipboard holds no TableCraft data sources.";
const COPY_FIRST = "Copy data sources in TableCraft's Database pane, then paste again.";

const selected = (context: ActionContext) => selectionOf(context.items, context.datasources);
const hasSaved = (context: ActionContext) => context.datasources.some((view) => !view.ephemeral);

async function notice(title: string, message: string, hint: string): Promise<void> {
  await useModal.getState().ask({ kind: "notice", title, message, hint });
}

async function paste(): Promise<void> {
  const text = await navigator.clipboard.readText();
  if (text.trim() === "" || new TextEncoder().encode(text).length > MAX_PASTED_BYTES) {
    await notice("Could not paste data sources", NOTHING_TO_PASTE, COPY_FIRST);
    return;
  }
  const request: ImportPreviewRequest = { source: "text", text };
  const answer = await bridge().importPreview(request);
  if (!answer.ok) {
    await notice("Could not paste data sources", answer.error.message, answer.error.hint);
    return;
  }
  if (answer.value.status !== "ready") return;
  useDataSourcesDialog.getState().hide();
  useImportDataSourcesDialog.getState().show({ preview: answer.value, request });
}

/**
 * Export, copy and paste of data source definitions (plan 040). Copy never carries a password;
 * paste reads the clipboard here and hands the text to main, which reads it as an exported file.
 */
export const DATASOURCE_FILE_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: DATASOURCE_FILE_ACTION_IDS.exportDatasources,
    title: "Export Data Sources…",
    category: "Database",
    icon: "export",
    when: hasSaved,
    run: (context) => useExportDataSourcesDialog.getState().show(selected(context)),
  }),
  defineAction({
    id: DATASOURCE_FILE_ACTION_IDS.copyDatasources,
    title: "Copy Data Sources",
    category: "Database",
    icon: "copy",
    shortcut: "Mod+C",
    shortcutRegion: "database",
    when: (context) => !context.speedSearching && !isEmptySelection(selected(context)),
    run: async (context) => {
      const answer = await bridge().copyDatasources(selected(context));
      if (answer.ok) await writeClipboard(answer.value);
      else await notice("Could not copy data sources", answer.error.message, answer.error.hint);
    },
  }),
  defineAction({
    id: DATASOURCE_FILE_ACTION_IDS.pasteDatasources,
    title: "Paste Data Sources",
    category: "Database",
    shortcut: "Mod+V",
    shortcutRegion: "database",
    when: (context) => !context.speedSearching,
    run: paste,
  }),
];
