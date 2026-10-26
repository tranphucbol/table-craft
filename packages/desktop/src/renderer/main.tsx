import { createRoot } from "react-dom/client";
import { App } from "@table-craft/desktop/renderer/App.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { installSnippetsSync, useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import { installAppearance, installSettingsSync } from "@table-craft/desktop/renderer/state/wiring.js";
import { installRendererErrorLog, rendererLog } from "@table-craft/desktop/renderer/log/log.js";
import "./app.css";

const container = document.getElementById("app");
if (container === null) throw new Error("index.html is missing the #app element.");

installRendererErrorLog(window);
const reactLog = rendererLog("react");

// Settings are read and applied before the first render, so no frame shows the wrong theme.
installSettingsSync();
installSnippetsSync();
void useSnippets.getState().load();
await useSettings.getState().load();
installAppearance();
// No StrictMode: its doubled effects would ask main for two engine ports.
createRoot(container, {
  onUncaughtError: (error, info) =>
    reactLog.error("render failed", { err: error, componentStack: info.componentStack }),
  onRecoverableError: (error) => reactLog.warn("render recovered", { err: error }),
}).render(<App />);
