/** Files DuckDB reads straight into a query; the reader and any decompression follow from the suffix. */
export const DATA_FILE_SUFFIXES = [
  ".parquet",
  ".csv",
  ".tsv",
  ".csv.gz",
  ".tsv.gz",
  ".csv.zst",
  ".tsv.zst",
  ".json",
  ".ndjson",
  ".jsonl",
] as const;
/** The view over a glob, which has no one file to be named after. */
export const GLOB_VIEW = "data";
const GLOB = "*";
const SEPARATORS = /[\\/]/u;

/** The view a data-file datasource opens on, and the file or glob it reads. */
export interface DataFileView {
  readonly view: string;
  readonly source: string;
}

function suffixOf(path: string): string | undefined {
  const lower = path.toLowerCase();
  return DATA_FILE_SUFFIXES.filter((suffix) => lower.endsWith(suffix)).sort((a, b) => b.length - a.length)[0];
}

/** The view opened over `path`, or null when `path` is a database file or `:memory:`. */
export function dataFileView(path: string): DataFileView | null {
  const suffix = suffixOf(path);
  if (suffix === undefined) return null;
  if (path.includes(GLOB)) return { view: GLOB_VIEW, source: path };
  const name = path.split(SEPARATORS).at(-1) ?? path;
  const stem = name.slice(0, name.length - suffix.length);
  return { view: stem === "" ? GLOB_VIEW : stem, source: path };
}
