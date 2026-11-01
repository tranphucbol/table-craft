/** The tree's sibling order for names: numeric, case- and accent-insensitive. */
export const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
export const FOLDER_SEPARATOR = "/";

/** A datasource or folder row of the Database tree, the things that move and delete together. */
export type TreeItemRef =
  { readonly kind: "datasource"; readonly id: string } | { readonly kind: "folder"; readonly path: string };

export interface MoveRequest {
  readonly items: readonly TreeItemRef[];
  /** The destination parent; null is the top level. */
  readonly folder: string | null;
  /** The sibling in `folder` to land before; null is the end. Folders stay above datasources whatever it names. */
  readonly before: TreeItemRef | null;
}

interface Placed {
  readonly id: string;
  readonly folder: string | null;
}

export interface ArrangeTree<T extends Placed> {
  readonly folders: readonly string[];
  readonly datasources: readonly T[];
}

export interface Arranged<T extends Placed> extends ArrangeTree<T> {
  /** Old path → new path for every folder the move renamed, for the renderer's collapse and selection state. */
  readonly renamed: ReadonlyMap<string, string>;
  /** False when the move leaves the tree as it was, so nothing needs writing. */
  readonly changed: boolean;
}

/** A move that cannot apply; main hands its message and hint to the renderer as they are. */
export class ArrangeError extends Error {
  override readonly name = "ArrangeError";
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** `/`-separated, trimmed, without empty segments; null for the top level. */
export function normalizeFolder(folder: string | null): string | null {
  const segments = (folder ?? "")
    .split(FOLDER_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  return segments.length === 0 ? null : segments.join(FOLDER_SEPARATOR);
}

/** `Docker/Main` → `Docker`, `Docker/Main`. */
export function folderAncestors(folder: string | null): readonly string[] {
  if (folder === null) return [];
  const parts = folder.split(FOLDER_SEPARATOR);
  return parts.map((_, index) => parts.slice(0, index + 1).join(FOLDER_SEPARATOR));
}

/** The folder holding `path`; null at the top level. */
export function parentFolder(path: string): string | null {
  const cut = path.lastIndexOf(FOLDER_SEPARATOR);
  return cut < 0 ? null : path.slice(0, cut);
}

export function folderName(path: string): string {
  return path.slice(path.lastIndexOf(FOLDER_SEPARATOR) + 1);
}

/** True when `path` is `folder` itself or lies anywhere below it. */
export function isWithin(path: string | null, folder: string): boolean {
  return path !== null && (path === folder || path.startsWith(`${folder}${FOLDER_SEPARATOR}`));
}

function childPath(parent: string | null, name: string): string {
  return parent === null ? name : `${parent}${FOLDER_SEPARATOR}${name}`;
}

/**
 * Every path once, normalized, each after its ancestors, with the ancestors of every path and of
 * every datasource's folder; first-seen order, missing ones appended.
 */
export function normalizeFolders(
  folders: readonly string[],
  datasources: readonly { readonly folder: string | null }[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (path: string | null) => {
    for (const ancestor of folderAncestors(normalizeFolder(path))) {
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      result.push(ancestor);
    }
  };
  for (const path of folders) add(path);
  for (const { folder } of datasources) add(folder);
  return result;
}

/** A–Z segment by segment, so `Prod/EU` sorts with `Prod`, not after `Prod EU`. */
export function compareFolderPaths(a: string, b: string): number {
  const left = a.split(FOLDER_SEPARATOR);
  const right = b.split(FOLDER_SEPARATOR);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = NAME_ORDER.compare(left[index] ?? "", right[index] ?? "");
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

const GONE_HINT = "It may have been deleted; try again.";

function sameKind(a: TreeItemRef, b: TreeItemRef): boolean {
  return a.kind === "datasource" ? b.kind === "datasource" && a.id === b.id : b.kind === "folder" && a.path === b.path;
}

/** The selected items, without those already inside a selected folder, since they move with it. */
export function topmostItems(items: readonly TreeItemRef[], datasources: readonly Placed[]): TreeItemRef[] {
  const folders = items.flatMap((item) => (item.kind === "folder" ? [item.path] : []));
  const unique = items.filter((item, index) => items.findIndex((other) => sameKind(item, other)) === index);
  return unique.filter((item) => {
    if (item.kind === "folder") return !folders.some((other) => other !== item.path && isWithin(item.path, other));
    const folder = datasources.find((datasource) => datasource.id === item.id)?.folder ?? null;
    return !folders.some((other) => isWithin(folder, other));
  });
}

function check<T extends Placed>(tree: ArrangeTree<T>, request: MoveRequest): void {
  const known = new Set(tree.folders);
  const missingFolder = (path: string) => new ArrangeError(`No folder "${path}".`, GONE_HINT);
  if (request.folder !== null && !known.has(request.folder)) throw missingFolder(request.folder);
  for (const item of [...request.items, ...(request.before === null ? [] : [request.before])]) {
    if (item.kind === "folder" && !known.has(item.path)) throw missingFolder(item.path);
    if (item.kind === "datasource" && !tree.datasources.some((datasource) => datasource.id === item.id)) {
      throw new ArrangeError(`No data source with id "${item.id}".`, GONE_HINT);
    }
  }
  const before = request.before;
  if (before !== null) {
    const parent =
      before.kind === "folder"
        ? parentFolder(before.path)
        : (tree.datasources.find((datasource) => datasource.id === before.id)?.folder ?? null);
    if (parent !== request.folder) {
      throw new ArrangeError("The drop target is not in the destination folder.", "Drop it again.");
    }
  }
}

/** Folder renames the move makes, after checking it neither nests a folder in itself nor clashes. */
function renamesOf(folders: readonly string[], moved: readonly string[], destination: string | null) {
  const renamed = new Map<string, string>();
  const staying = folders.filter((path) => !moved.some((folder) => isWithin(path, folder)));
  const landing = new Set<string>();
  for (const folder of moved) {
    const name = folderName(folder);
    if (isWithin(destination, folder)) {
      throw new ArrangeError(`Cannot move "${name}" into itself.`, `Drop it outside ${name}.`);
    }
    const target = childPath(destination, name);
    if (staying.includes(target) || landing.has(target)) {
      const where = destination === null ? "The top level" : `Folder "${destination}"`;
      throw new ArrangeError(
        `${where} already has a folder named "${name}".`,
        "Move it somewhere else, or move its data sources with Move to Folder….",
      );
    }
    landing.add(target);
    if (target === folder) continue;
    for (const path of folders) {
      if (isWithin(path, folder)) renamed.set(path, `${target}${path.slice(folder.length)}`);
    }
  }
  return renamed;
}

/** `list` with `block` put back before the first entry `isAnchor` accepts, or at the end. */
function insertBefore<T>(list: readonly T[], block: readonly T[], isAnchor: (entry: T) => boolean): T[] {
  const at = list.findIndex(isAnchor);
  return at < 0 ? [...list, ...block] : [...list.slice(0, at), ...block, ...list.slice(at)];
}

/**
 * Applies one move to the stored order (plan 136). Main runs it under the file write; the renderer
 * runs it while dragging, so it only offers a drop main would take.
 */
export function arrange<T extends Placed>(tree: ArrangeTree<T>, request: MoveRequest): Arranged<T> {
  check(tree, request);
  const items = topmostItems(request.items, tree.datasources);
  const movedFolders = items.flatMap((item) => (item.kind === "folder" ? [item.path] : []));
  const movedIds = new Set(items.flatMap((item) => (item.kind === "datasource" ? [item.id] : [])));
  const renamed = renamesOf(tree.folders, movedFolders, request.folder);
  const rename = (path: string | null) => (path === null ? null : (renamed.get(path) ?? path));
  const inMovedFolder = (path: string | null) => movedFolders.some((folder) => isWithin(path, folder));
  const { before, folder: destination } = request;

  const folderBlock = tree.folders.filter(inMovedFolder).map((path) => rename(path) ?? path);
  const folderRest = tree.folders.filter((path) => !inMovedFolder(path));
  const siblingFolders = tree.folders.filter((path) => parentFolder(path) === destination);
  const beforeAt = before?.kind === "folder" ? siblingFolders.indexOf(before.path) : -1;
  const folderAnchor = beforeAt < 0 ? undefined : siblingFolders.slice(beforeAt).find((path) => !inMovedFolder(path));
  const folders =
    folderBlock.length === 0
      ? [...tree.folders]
      : insertBefore(folderRest, folderBlock, (path) => path === folderAnchor);

  const datasourceBlock = tree.datasources
    .filter((datasource) => movedIds.has(datasource.id))
    .map((datasource) => (datasource.folder === destination ? datasource : { ...datasource, folder: destination }));
  const datasourceRest = tree.datasources
    .filter((datasource) => !movedIds.has(datasource.id))
    .map((datasource) => {
      const folder = rename(datasource.folder);
      return folder === datasource.folder ? datasource : { ...datasource, folder };
    });
  const siblings = tree.datasources.filter((datasource) => datasource.folder === destination);
  const anchorAt = before?.kind === "datasource" ? siblings.findIndex((datasource) => datasource.id === before.id) : 0;
  const anchor =
    before === null || anchorAt < 0
      ? undefined
      : siblings.slice(anchorAt).find((datasource) => !movedIds.has(datasource.id))?.id;
  const datasources =
    datasourceBlock.length === 0
      ? datasourceRest
      : insertBefore(datasourceRest, datasourceBlock, (datasource) => datasource.id === anchor);

  const changed =
    folders.some((path, index) => path !== tree.folders[index]) ||
    datasources.some((datasource, index) => datasource !== tree.datasources[index]);
  return changed
    ? { folders, datasources, renamed, changed }
    : { folders: tree.folders, datasources: tree.datasources, renamed: new Map(), changed };
}

/** The first selected folder that deleting the selection would leave holding something; null when none. */
export function folderKeepingContent(
  tree: ArrangeTree<Placed>,
  ids: readonly string[],
  folders: readonly string[],
): string | null {
  const deleted = new Set(folders);
  for (const folder of folders) {
    const keepsFolder = tree.folders.some((path) => path !== folder && isWithin(path, folder) && !deleted.has(path));
    const keepsDatasource = tree.datasources.some(
      (datasource) => isWithin(datasource.folder, folder) && !ids.includes(datasource.id),
    );
    if (keepsFolder || keepsDatasource) return folder;
  }
  return null;
}
