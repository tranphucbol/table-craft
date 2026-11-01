/**
 * The engine's SQL work on the 100k-id `IN (...)` statement, timed in-process with the MySQL
 * plugin's language and no database: what Run, completion and parameter info cost before the
 * statement reaches the server.
 *
 *   bun test/perf/bench.ts
 */
import plugin from "@table-craft/plugin-mysql";
import { IN_PREFIX, inListQuery, PERF_DATABASE, perfIds } from "./fixtures.js";

type Call = (...args: never[]) => unknown;

const RUNS = 5;
const LABEL_WIDTH = 44;
const NUMBER_WIDTH = 8;
const IDS_PER_LINE = 10;
const SIGNATURE_OFFSET = 20;
const COMPLETION_PREFIX = "sta";
const COLUMNS = ["user_id", "username", "email", "phone", "status", "balance", "created_at"];

const language = (plugin as unknown as { language: Record<string, Call | undefined> }).language;

const catalog = {
  current: [PERF_DATABASE],
  server: { product: "mysql", version: "8.4.0" },
  namespaces: () => Promise.resolve([{ name: PERF_DATABASE }]),
  relations: () =>
    Promise.resolve([{ name: "users", kind: "table", columns: COLUMNS.map((name) => ({ name, type: "varchar" })) }]),
  referencing: () => Promise.resolve([]),
};

function call<T>(name: string, ...args: unknown[]): T {
  const method = language[name];
  if (method === undefined) throw new Error(`the MySQL language has no ${name}`);
  return (method as (...a: unknown[]) => T)(...args);
}

async function time(label: string, fn: () => unknown): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = (samples[Math.floor(RUNS / 2)] ?? 0).toFixed(1).padStart(NUMBER_WIDTH);
  const max = (samples.at(-1) ?? 0).toFixed(1).padStart(NUMBER_WIDTH);
  console.log(`${label.padEnd(LABEL_WIDTH)} median ${median} ms  max ${max} ms`);
}

const ids = perfIds();
for (const [variant, perLine] of [
  ["oneline", undefined],
  ["multiline", IDS_PER_LINE],
] as const) {
  const text = inListQuery(ids, perLine);
  const where = IN_PREFIX.indexOf("user_id");
  const edited = `${text.slice(0, where)}${COMPLETION_PREFIX}${text.slice(where)}`;
  console.log(`\n${variant}: ${String(text.length)} chars`);
  const sql = call<{ sql: string }[]>("split", text)[0]?.sql ?? text;
  await time("split (script.split on Run)", () => call("split", text));
  await time("classify (x3 per Run: split, execute, log)", () => call("classify", sql));
  await time("parameters (script.split on Run)", () => call("parameters", sql));
  await time(`complete at WHERE ${COMPLETION_PREFIX}|`, () =>
    call("complete", { text: edited, offset: where + COMPLETION_PREFIX.length }, catalog),
  );
  await time("signatureAt inside IN (", () =>
    call("signatureAt", { text, offset: text.indexOf("(") + SIGNATURE_OFFSET }, catalog),
  );
  if (language["inspect"] !== undefined) {
    await time("inspect (the app skips it over 200k chars)", () => call("inspect", { text }, catalog));
  }
}
