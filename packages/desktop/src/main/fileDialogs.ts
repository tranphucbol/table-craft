import { writeFile } from "node:fs/promises";
import { BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions, type WebContents } from "electron";
import type { ChartImageRequest } from "@table-craft/desktop/charts/state.js";
import type { DiagramImageFormat, DiagramImageRequest } from "@table-craft/desktop/diagrams/state.js";

const IMPORT_FILE_FILTERS = [
  { name: "Delimited text", extensions: ["csv", "tsv", "txt"] },
  { name: "All files", extensions: ["*"] },
];
const SQL_FILE_FILTERS = [
  { name: "SQL files", extensions: ["sql"] },
  { name: "All files", extensions: ["*"] },
];

export async function saveFile(contents: WebContents, title: string, defaultName: string): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: SaveDialogOptions = { title, defaultPath: defaultName, properties: ["createDirectory"] };
  const picked = parent === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
  return picked.canceled || picked.filePath === "" ? null : picked.filePath;
}

const DIAGRAM_IMAGE_TITLES: Readonly<Record<DiagramImageFormat, string>> = {
  svg: "Export Diagram as SVG",
  png: "Export Diagram as PNG",
};
const DIAGRAM_IMAGE_FILTERS: Readonly<Record<DiagramImageFormat, { name: string; extensions: string[] }>> = {
  svg: { name: "SVG image", extensions: ["svg"] },
  png: { name: "PNG image", extensions: ["png"] },
};

export async function exportDiagramImage(contents: WebContents, request: DiagramImageRequest): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: SaveDialogOptions = {
    title: DIAGRAM_IMAGE_TITLES[request.format],
    defaultPath: request.defaultName,
    filters: [DIAGRAM_IMAGE_FILTERS[request.format]],
    properties: ["createDirectory"],
  };
  const picked = parent === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
  if (picked.canceled || picked.filePath === "") return null;
  await writeFile(picked.filePath, request.data);
  return picked.filePath;
}

const CHART_IMAGE_TITLE = "Export Chart as PNG";
const CHART_IMAGE_FILTER = { name: "PNG image", extensions: ["png"] };

export async function exportChartImage(contents: WebContents, request: ChartImageRequest): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: SaveDialogOptions = {
    title: CHART_IMAGE_TITLE,
    defaultPath: request.defaultName,
    filters: [CHART_IMAGE_FILTER],
    properties: ["createDirectory"],
  };
  const picked = parent === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
  if (picked.canceled || picked.filePath === "") return null;
  await writeFile(picked.filePath, request.data);
  return picked.filePath;
}

export async function chooseFile(contents: WebContents, title: string): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: OpenDialogOptions = { title, properties: ["openFile", "promptToCreate"] };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

/** The open dialog for one existing file: one to import, or with `anyFile` one to load into a binary cell. */
export async function openFile(contents: WebContents, title: string, anyFile = false): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: OpenDialogOptions = {
    title,
    properties: ["openFile"],
    ...(anyFile ? {} : { filters: IMPORT_FILE_FILTERS }),
  };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

export async function chooseSqlFiles(contents: WebContents, title: string): Promise<readonly string[]> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: OpenDialogOptions = { title, properties: ["openFile", "multiSelections"], filters: SQL_FILE_FILTERS };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? [] : picked.filePaths;
}
