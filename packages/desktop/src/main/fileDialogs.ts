import { BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions, type WebContents } from "electron";

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
