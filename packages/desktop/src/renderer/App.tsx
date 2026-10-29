import { useEffect } from "react";
import { currentPlatform } from "@table-craft/desktop/renderer/actions/chords.js";
import {
  answerCloseRequests,
  autosaveConsoles,
  fileConsoles,
  openConsole,
  rememberOpenConsoles,
  restoreConsoles,
} from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { currentContext, focusedRegion, modalOpen, trackFocus } from "@table-craft/desktop/renderer/actions/context.js";
import { openRecentFromMenu, syncFileConsoles } from "@table-craft/desktop/renderer/actions/fileActions.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import { installKeymap } from "@table-craft/desktop/renderer/actions/keymap.js";
import { rememberOpenTables, restoreTables } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { QuickDoc } from "@table-craft/desktop/renderer/catalog/QuickDoc.js";
import { editorReservedChords } from "@table-craft/desktop/renderer/console/editorKeys.js";
import { DataSourcesDialog } from "@table-craft/desktop/renderer/dialogs/DataSources.js";
import { ImportDataSourcesDialog } from "@table-craft/desktop/renderer/dialogs/ImportDataSources.js";
import { ManageShownSchemasDialog } from "@table-craft/desktop/renderer/dialogs/ManageShownSchemas.js";
import { HostKeyPrompt } from "@table-craft/desktop/renderer/dialogs/HostKeyPrompt.js";
import { McpActivityDialog } from "@table-craft/desktop/renderer/dialogs/McpActivity.js";
import { McpApprovalDialog } from "@table-craft/desktop/renderer/dialogs/McpApproval.js";
import { Modal } from "@table-craft/desktop/renderer/dialogs/Modal.js";
import { SecretPrompt } from "@table-craft/desktop/renderer/dialogs/SecretPrompt.js";
import { SettingsDialog } from "@table-craft/desktop/renderer/dialogs/Settings.js";
import { SnippetsDialog } from "@table-craft/desktop/renderer/dialogs/Snippets.js";
import { Palette } from "@table-craft/desktop/renderer/palette/Palette.js";
import { Shell } from "@table-craft/desktop/renderer/shell/Shell.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { installHostKeyPrompts } from "@table-craft/desktop/renderer/state/hostKeyPrompt.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { installUpdateState } from "@table-craft/desktop/renderer/state/update.js";
import { installMcpState } from "@table-craft/desktop/renderer/state/mcp.js";
import { installMcpConsoleRelay } from "@table-craft/desktop/renderer/actions/mcpConsole.js";
import { installWindowState } from "@table-craft/desktop/renderer/state/windowState.js";
import { installDatasourceSync } from "@table-craft/desktop/renderer/state/wiring.js";
import { TooltipProvider } from "@table-craft/desktop/renderer/ui/Tooltip.js";

/** The `TABLE_CRAFT_DATASOURCE` seam opens straight into a console on it, as before (decision 018). */
function openEphemeralConsole(): void {
  const ephemeral = useDatasources.getState().datasources.find((datasource) => datasource.ephemeral);
  if (ephemeral !== undefined && useTabs.getState().tabs.length === 0) void openConsole(ephemeral.id);
}

/**
 * The first datasource list is in: reopen the remembered consoles (or the ephemeral one), then
 * start remembering and saving them. Remembering starts after, so an empty strip at launch never
 * overwrites the layout it is about to restore.
 */
let stopConsoleSync: (() => void) | null = null;
function onFirstList(): void {
  void restoreConsoles().then(() => {
    if (stopConsoleSync === null) restoreTables();
    openEphemeralConsole();
    if (stopConsoleSync !== null) return;
    const forget = rememberOpenConsoles();
    const forgetTables = rememberOpenTables();
    const stopSaving = autosaveConsoles();
    const forgetAttachments = fileConsoles.rememberAttachments();
    stopConsoleSync = () => {
      forget();
      forgetTables();
      stopSaving();
      forgetAttachments();
    };
  });
}

export function App() {
  useEffect(
    () =>
      installKeymap(window, {
        registry,
        platform: currentPlatform(),
        paletteOpen: modalOpen,
        focusedRegion,
        reservedChords: editorReservedChords,
      }),
    [],
  );

  useEffect(() => trackFocus(document), []);

  useEffect(() => bridge().onInvokeAction((actionId) => invoke(actionId)), []);

  useEffect(() => installDatasourceSync(onFirstList), []);

  useEffect(() => answerCloseRequests(), []);

  useEffect(() => installHostKeyPrompts(), []);

  useEffect(() => openRecentFromMenu(currentContext), []);

  useEffect(() => syncFileConsoles(window), []);

  useEffect(() => installWindowState(), []);

  useEffect(() => installUpdateState(), []);
  useEffect(() => installMcpState(), []);
  useEffect(() => installMcpConsoleRelay(), []);

  return (
    <TooltipProvider>
      <Shell />
      <Palette />
      <DataSourcesDialog />
      <ImportDataSourcesDialog />
      <ManageShownSchemasDialog />
      <SettingsDialog />
      <SnippetsDialog />
      <SecretPrompt />
      <HostKeyPrompt />
      <McpApprovalDialog />
      <McpActivityDialog />
      <Modal />
      <QuickDoc />
    </TooltipProvider>
  );
}
