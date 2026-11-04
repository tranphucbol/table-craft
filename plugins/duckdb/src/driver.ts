import type * as DuckdbApi from "@duckdb/node-api";

/**
 * The only module that loads `@duckdb/node-api` at run time. Importing it opens the native binding,
 * so it waits for the first connect: the loader and `plugins:check` import every plugin, including
 * the five other platforms' DuckDB packages, and must never touch a binary (decision 156).
 */
export type DuckdbDriver = typeof DuckdbApi;

let loading: Promise<DuckdbDriver> | null = null;

export function loadDriver(): Promise<DuckdbDriver> {
  loading ??= import("@duckdb/node-api").catch((cause: unknown) => {
    loading = null;
    throw cause;
  });
  return loading;
}
