import type { ExportFormat } from "@table-craft/desktop/engine/protocol.js";
import { EXPORT_FORMATS } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { selectedRelation } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { isRunning, useExports, type ExportEntry } from "@table-craft/desktop/renderer/state/exports.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { parseExportAnswer, useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

export const EXPORT_ACTION_IDS = {
  exportRelation: "explorer.export",
  cancel: "export.cancel",
  retry: "export.retry",
  reveal: "export.reveal",
  dismiss: "export.dismiss",
  show: "export.show",
  cancelAll: "export.cancelAll",
} as const;

export const EXPORT_FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  sqlInsert: "SQL Inserts",
  markdown: "Markdown",
  xlsx: "Excel (XLSX)",
};

const EXPORT_EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  sqlInsert: "sql",
  markdown: "md",
  xlsx: "xlsx",
};

const SAVE_TITLE = "Export Data";
const DIALOG_TITLE = "Export Data";

export function defaultExportName(title: string, format: ExportFormat): string {
  return `${title}.${EXPORT_EXTENSIONS[format]}`;
}

function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Swaps a path's extension for the format's, so switching format in the dialog keeps the name. */
export function withExtension(path: string, format: ExportFormat): string {
  const known = Object.values(EXPORT_EXTENSIONS).find((extension) => path.endsWith(`.${extension}`));
  const stem = known === undefined ? path : path.slice(0, -(known.length + 1));
  return `${stem}.${EXPORT_EXTENSIONS[format]}`;
}

export interface ExportChoice {
  readonly format: ExportFormat;
  readonly columns: readonly number[];
  readonly path: string;
  readonly shownOnly: boolean;
}

/** The Export Data dialog (decision 040): a format, the columns and a file; null when cancelled. */
export async function askExport(request: {
  readonly name: string;
  readonly columns: readonly string[];
  readonly chosen: readonly number[];
  readonly note: string;
  readonly rows?: { readonly shownLabel: string; readonly wholeLabel: string; readonly shownNote: string };
}): Promise<ExportChoice | null> {
  const modal = useModal.getState();
  const answer = await modal.ask({
    kind: "export",
    title: DIALOG_TITLE,
    formats: EXPORT_FORMATS.map((format) => ({ id: format, label: EXPORT_FORMAT_LABELS[format] })),
    initialFormat: useLayout.getState().layout.extractor,
    columns: request.columns,
    chosen: request.chosen,
    note: request.note,
    ...(request.rows === undefined ? {} : { rows: request.rows }),
    retarget: (path, format) => (isExportFormat(format) ? withExtension(path, format) : path),
    browse: async (format, current) => {
      const exportFormat = isExportFormat(format) ? format : "csv";
      const suggested = current === "" ? defaultExportName(request.name, exportFormat) : current;
      const chosen = await bridge().saveFile(SAVE_TITLE, suggested);
      return chosen.ok ? chosen.value : null;
    },
  });
  if (answer === null) return null;
  const parsed = parseExportAnswer(answer);
  if (!isExportFormat(parsed.format)) return null;
  return { format: parsed.format, columns: parsed.columns, path: parsed.path, shownOnly: parsed.shownOnly === true };
}

export async function reportExportFailure(cause: unknown): Promise<void> {
  const error = toError(cause);
  await useModal
    .getState()
    .ask({ kind: "notice", title: "Could not export", message: error.message, hint: error.hint });
}

/** A Services line names its task; from the palette the newest one the action fits. */
export interface ExportTaskArgs {
  readonly taskId: string;
}

function entryFor(
  args: Partial<ExportTaskArgs> | undefined,
  fits: (entry: ExportEntry) => boolean,
): ExportEntry | null {
  const { entries } = useExports.getState();
  if (args?.taskId !== undefined) {
    const entry = entries.find((candidate) => candidate.task.taskId === args.taskId);
    return entry !== undefined && fits(entry) ? entry : null;
  }
  return [...entries].reverse().find(fits) ?? null;
}

const cancellable = (entry: ExportEntry) => isRunning(entry);
const retryable = (entry: ExportEntry) => !isRunning(entry) && entry.task.state !== "done" && entry.task.retryable;
const revealable = (entry: ExportEntry) => entry.task.state === "done";
const dismissable = (entry: ExportEntry) => !isRunning(entry);
/** With one export running, its own Cancel says the same thing. */
const CANCEL_ALL_MIN = 2;

/** The selected table or view with the columns the catalog knows for it. */
function relationToExport(context: ActionContext) {
  const target = selectedRelation(context);
  if (target === null) return null;
  const described =
    useCatalog.getState().catalogs[target.datasourceId]?.namespaceStates[pathKey(target.path)]?.described;
  const relation = described?.catalog.relations.find((candidate) => candidate.name === target.relation);
  if (relation === undefined || relation.columns.length === 0) return null;
  return { ...target, columns: relation.columns.map((column) => column.name) };
}

export const EXPORT_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: EXPORT_ACTION_IDS.exportRelation,
    title: "Export Data…",
    category: "Database",
    icon: "export",
    when: (context) => relationToExport(context) !== null,
    run: async (context) => {
      const target = relationToExport(context);
      if (target === null) return;
      const choice = await askExport({
        name: target.relation,
        columns: target.columns,
        chosen: target.columns.map((_, index) => index),
        note: `Every row of ${[...target.path, target.relation].join(".")}, read on a connection of its own.`,
      });
      if (choice === null) return;
      const columns = choice.columns.flatMap((index) => target.columns[index] ?? []);
      try {
        await useExports.getState().start(target.datasourceId, {
          source: { kind: "table", path: target.path, relation: target.relation, columns },
          format: choice.format,
          path: choice.path,
        });
      } catch (cause) {
        await reportExportFailure(cause);
      }
    },
  }),
  defineAction<Partial<ExportTaskArgs> | undefined>({
    id: EXPORT_ACTION_IDS.cancel,
    title: "Cancel Export",
    category: "Tool Windows",
    icon: "cancel",
    when: () => entryFor(undefined, cancellable) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, cancellable);
      if (entry !== null) await useExports.getState().cancel(entry.task.taskId);
    },
  }),
  defineAction<Partial<ExportTaskArgs> | undefined>({
    id: EXPORT_ACTION_IDS.retry,
    title: "Retry Export",
    category: "Tool Windows",
    icon: "rerun",
    when: () => entryFor(undefined, retryable) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, retryable);
      if (entry === null) return;
      try {
        await useExports.getState().retry(entry.task.taskId);
      } catch (cause) {
        await reportExportFailure(cause);
      }
    },
  }),
  defineAction<Partial<ExportTaskArgs> | undefined>({
    id: EXPORT_ACTION_IDS.reveal,
    title: "Reveal Exported File",
    category: "Tool Windows",
    icon: "folder",
    when: () => entryFor(undefined, revealable) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, revealable);
      if (entry === null) return;
      const revealed = await bridge().revealFile(entry.task.path);
      if (!revealed.ok) {
        await useModal.getState().ask({ kind: "notice", title: "Could not reveal the file", ...revealed.error });
      }
    },
  }),
  defineAction<Partial<ExportTaskArgs> | undefined>({
    id: EXPORT_ACTION_IDS.dismiss,
    title: "Remove Finished Export",
    category: "Tool Windows",
    icon: "close",
    when: () => entryFor(undefined, dismissable) !== null,
    run: (_context, args) => {
      const entry = entryFor(args, dismissable);
      if (entry !== null) useExports.getState().dismiss(entry.task.taskId);
    },
  }),
  defineAction({
    id: EXPORT_ACTION_IDS.show,
    title: "Show Exports",
    category: "Tool Windows",
    icon: "export",
    when: () => useExports.getState().entries.length > 0,
    run: () => useExports.getState().setPopover(!useExports.getState().popoverOpen),
  }),
  defineAction({
    id: EXPORT_ACTION_IDS.cancelAll,
    title: "Cancel All Exports",
    category: "Tool Windows",
    icon: "cancel",
    when: () => useExports.getState().entries.filter(cancellable).length >= CANCEL_ALL_MIN,
    run: async () => {
      const { entries, cancel } = useExports.getState();
      await Promise.all(entries.filter(cancellable).map((entry) => cancel(entry.task.taskId)));
    },
  }),
];
