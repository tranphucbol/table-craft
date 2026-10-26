import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { LogRecord } from "@table-craft/desktop/log/record.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { ALL_RECORDS, isAllRecords, useLogView, type LogTarget } from "@table-craft/desktop/renderer/state/logView.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";

export const LOG_ACTION_IDS = {
  show: "log.show",
  showFor: "log.showFor",
  reveal: "log.reveal",
  copyRecord: "log.copyRecord",
  clearFilter: "log.clearFilter",
  exportDiagnostics: "diagnostics.export",
} as const;

export interface CopyRecordArgs {
  readonly record: LogRecord;
}

/** What the confirmation lists, so the user knows what leaves the machine before saving (plan 017 decision 10). */
export const DIAGNOSTICS_CONTENTS = [
  { label: "logs/", detail: "The app log, current and rotated files", tone: "info" },
  { label: "about.json", detail: "Versions, operating system, installed plugins", tone: "info" },
  { label: "settings.json", detail: "Your settings", tone: "info" },
  { label: "datasources.json", detail: "Datasource names, drivers and hosts; never passwords", tone: "info" },
  {
    label: "history.json",
    detail: "The last 50 runs: datasource, outcome, rows, duration; never SQL text",
    tone: "info",
  },
] as const;

function isLogTarget(args: unknown): args is LogTarget {
  return typeof args === "object" && args !== null && "message" in args;
}

function isCopyRecordArgs(args: unknown): args is CopyRecordArgs {
  return typeof args === "object" && args !== null && "record" in args;
}

async function notice(title: string, message: string, hint: string, tone?: "info"): Promise<void> {
  await useModal.getState().ask({ kind: "notice", title, message, hint, ...(tone === undefined ? {} : { tone }) });
}

async function exportDiagnostics(): Promise<void> {
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Export Diagnostics",
    message:
      "Saves a zip to attach to a bug report. It holds no passwords, row data or SQL text; error messages from a database are kept as the database wrote them.",
    items: DIAGNOSTICS_CONTENTS,
    confirm: "Export…",
  });
  if (confirmed === null) return;
  const answer = await bridge().exportDiagnostics();
  if (!answer.ok) await notice("Could not export diagnostics", answer.error.message, answer.error.hint);
  else if (answer.value !== null)
    await notice("Diagnostics exported", answer.value, "Attach the zip to your report.", "info");
}

/** Help → Show Log, Reveal Log File and Export Diagnostics…, and the Log tool window's own commands. */
export const LOG_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: LOG_ACTION_IDS.show,
    title: "Show Log",
    category: "App",
    icon: "log",
    run: async () => {
      useLogView.getState().setFilter(ALL_RECORDS);
      useLayout.getState().show("log");
      await useLogView.getState().load();
    },
  }),
  defineAction<LogTarget>({
    id: LOG_ACTION_IDS.showFor,
    title: "Show in Log",
    category: "App",
    icon: "log",
    run: async (_context, args) => {
      await useLogView.getState().showFor(isLogTarget(args) ? args : { requestId: null, message: "" });
    },
  }),
  defineAction({
    id: LOG_ACTION_IDS.reveal,
    title: "Reveal Log File",
    category: "App",
    icon: "folder",
    run: async () => {
      const answer = await bridge().logReveal();
      if (!answer.ok) await notice("Could not reveal the log file", answer.error.message, answer.error.hint);
    },
  }),
  defineAction<CopyRecordArgs>({
    id: LOG_ACTION_IDS.copyRecord,
    title: "Copy Log Record",
    category: "App",
    icon: "copy",
    when: () => useLogView.getState().selected !== null,
    run: async (_context, args) => {
      const record = isCopyRecordArgs(args) ? args.record : useLogView.getState().selected;
      if (record !== null) await writeClipboard(JSON.stringify(record, null, 2));
    },
  }),
  defineAction({
    id: LOG_ACTION_IDS.clearFilter,
    title: "Clear Log Filter",
    category: "App",
    icon: "filter",
    when: () => !isAllRecords(useLogView.getState().filter),
    run: () => useLogView.getState().setFilter(ALL_RECORDS),
  }),
  defineAction({
    id: LOG_ACTION_IDS.exportDiagnostics,
    title: "Export Diagnostics…",
    category: "App",
    icon: "diagnostics",
    run: exportDiagnostics,
  }),
];
