/**
 * Measurement helpers of the performance benchmarks (`perf*.smoke.test.ts`): a renderer probe
 * (long tasks, frame gaps, key latency), a main-process sampler of every app process's CPU and
 * memory, the editor document and a report written after every step.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { expect } from "vitest";
import { PERF_DATABASE, PERF_EVIDENCE_NAME, PERF_OUTPUT_DIR } from "../perf/fixtures.js";
import { MYSQL_CONFIG } from "../support/databases.js";
import {
  answerSecretPrompt,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  launchApp,
  newProfile,
  openConsoleOn,
  seedDatasources,
  setWindowSize,
  toolWindow,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

export const PERF_ENABLED =
  DATABASES_ENABLED && basename(process.env["TABLE_CRAFT_EVIDENCE_DIR"] ?? "") === PERF_EVIDENCE_NAME;
export const STEP_TIMEOUT_MS = 300_000;
export const SCENARIO_MS = 1_200_000;
const SAMPLE_MS = 200;
const FRAME_GAP_MS = 50;
const POLL_MS = 25;
const BYTES_PER_MB = 1_048_576;
const KB_PER_MB = 1024;
const ENGINE_PROCESS_PREFIX = "table-craft-engine-";
const DATASOURCE_NAME = "perf";

const { password, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const SAVED: SavedDatasource = {
  id: DATASOURCE_NAME,
  name: DATASOURCE_NAME,
  pluginId: "mysql",
  config: { ...MYSQL_PLAIN, database: PERF_DATABASE, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};

const PROBE = `(() => {
  const p = { longTasks: [], gaps: [], keys: [], heap: [] };
  window.__perf = p;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) p.longTasks.push([e.startTime, e.duration]);
  }).observe({ type: "longtask" });
  let last = performance.now();
  const tick = (now) => { if (now - last > ${String(FRAME_GAP_MS)}) p.gaps.push([last, now - last]); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => p.heap.push([performance.now(), performance.memory.usedJSHeapSize]), ${String(SAMPLE_MS)});
  document.addEventListener("keydown", (e) => {
    const t = e.timeStamp;
    requestAnimationFrame(() => setTimeout(() => p.keys.push(performance.now() - t), 0));
  }, true);
})()`;

interface Probe {
  readonly longTasks: number[][];
  readonly gaps: number[][];
  readonly keys: number[];
  readonly heap: number[][];
}

interface Sample {
  readonly t: number;
  readonly p: Record<string, { cpu: number; kb: number }>;
}

interface PageNode {
  readonly attributes: ArrayLike<{ readonly value: string }>;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<PageNode>;
}

interface EditorView {
  readonly state: { readonly doc: { length: number; lines: number; sliceString(from: number, to: number): string } };
}

interface PageDocument {
  querySelector(selector: string): { cmTile?: { view?: EditorView; root?: { view?: EditorView } } } | null;
  querySelectorAll(selector: string): ArrayLike<PageNode>;
}

interface Scrollable extends PageNode {
  scrollTop: number;
  readonly scrollHeight: number;
}

export interface ProcessStats {
  readonly cpuSeconds: number;
  readonly avgCpuPct: number;
  readonly peakMB: number;
  readonly endMB: number;
}

/** A console on `perf_test` in a fresh profile, with the probe and the sampler running. */
export async function launchPerfConsole(): Promise<RunningApp & { readonly userDataDir: string }> {
  const userDataDir = newProfile();
  seedDatasources(userDataDir, [SAVED]);
  const running = await launchApp(null, { userDataDir });
  const { app, page } = running;
  await setWindowSize(app, EVIDENCE_WINDOW);
  await toolWindow(page, "Database").waitFor({ timeout: STEP_TIMEOUT_MS });
  await openConsoleOn(page, DATASOURCE_NAME);
  await answerSecretPrompt(page, DATASOURCE_NAME, password);
  await waitUntilReady(page);
  await page.evaluate(PROBE);
  await startSampler(app);
  return { ...running, userDataDir };
}

async function startSampler(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ app: electronApp }, [interval, enginePrefix]) => {
      const g = globalThis as unknown as { __samples: Sample[] };
      g.__samples = [];
      setInterval(() => {
        const p: Sample["p"] = {};
        for (const m of electronApp.getAppMetrics()) {
          const key = (m.name ?? "").startsWith(enginePrefix) ? "engine" : m.type === "Tab" ? "renderer" : m.type;
          const entry = (p[key] ??= { cpu: 0, kb: 0 });
          entry.cpu += m.cpu.cumulativeCPUUsage ?? 0;
          entry.kb += m.memory.workingSetSize;
        }
        g.__samples.push({ t: Date.now(), p });
      }, interval);
    },
    [SAMPLE_MS, ENGINE_PROCESS_PREFIX] as const,
  );
}

/** CPU seconds and working set of each process between two `Date.now()` times. */
export async function processStats(
  app: ElectronApplication,
  from: number,
  to: number,
): Promise<Record<string, ProcessStats>> {
  const samples = await app.evaluate(() => (globalThis as unknown as { __samples: Sample[] }).__samples);
  const before = samples.filter((s) => s.t <= from).at(-1) ?? samples[0];
  const inside = samples.filter((s) => s.t > from && s.t <= to + SAMPLE_MS);
  const after = inside.at(-1);
  const out: Record<string, ProcessStats> = {};
  if (before === undefined || after === undefined) return out;
  const seconds = Math.max(0.001, (after.t - before.t) / 1000);
  for (const key of Object.keys(after.p)) {
    const cpuSeconds = (after.p[key]?.cpu ?? 0) - (before.p[key]?.cpu ?? 0);
    out[key] = {
      cpuSeconds: Number(cpuSeconds.toFixed(2)),
      avgCpuPct: Math.round((cpuSeconds / seconds) * 100),
      peakMB: Math.round(Math.max(0, ...inside.map((s) => s.p[key]?.kb ?? 0)) / KB_PER_MB),
      endMB: Math.round((after.p[key]?.kb ?? 0) / KB_PER_MB),
    };
  }
  return out;
}

/** Long tasks and frame gaps between two `performance.now()` times of the page. */
export async function rendererStats(page: Page, from: number, to: number) {
  return page.evaluate(
    ([start, end, mb]) => {
      const p = (globalThis as unknown as { __perf: Probe }).__perf;
      const tasks = p.longTasks.filter(([s = 0]) => s >= start && s <= end);
      const gaps = p.gaps.filter(([s = 0]) => s >= start && s <= end);
      const heap = p.heap.filter(([s = 0]) => s >= start && s <= end).map(([, h = 0]) => h);
      return {
        longTasks: tasks.length,
        blockedMs: Math.round(tasks.reduce((a, [, d = 0]) => a + d, 0)),
        maxTaskMs: Math.round(Math.max(0, ...tasks.map(([, d = 0]) => d))),
        maxFrameGapMs: Math.round(Math.max(0, ...gaps.map(([, d = 0]) => d))),
        peakJsHeapMB: Math.round(Math.max(0, ...heap) / mb),
      };
    },
    [from, to, BYTES_PER_MB] as const,
  );
}

/** Keydown-to-next-frame latencies since the last call. */
export async function takeKeys(page: Page) {
  return page.evaluate(() => {
    const k = (globalThis as unknown as { __perf: Probe }).__perf.keys.splice(0).sort((a, b) => a - b);
    const at = (q: number) => Math.round(k[Math.min(k.length - 1, Math.floor(q * k.length))] ?? 0);
    return { keys: k.length, keyP50Ms: at(0.5), keyP95Ms: at(0.95), keyMaxMs: Math.round(k.at(-1) ?? 0) };
  });
}

export type EditorDoc = Awaited<ReturnType<typeof editorDoc>>;

/** The console document's size and ends, read from CodeMirror: it draws only the lines in view. */
export function editorDoc(page: Page) {
  return page.evaluate(() => {
    const content = (globalThis as unknown as { document: PageDocument }).document.querySelector(".cm-content");
    const view = content?.cmTile?.root?.view ?? content?.cmTile?.view;
    if (view === undefined) return { length: -1, lines: -1, head: "", tail: "" };
    const { doc } = view.state;
    return {
      length: doc.length,
      lines: doc.lines,
      head: doc.sliceString(0, 60),
      tail: doc.sliceString(Math.max(0, doc.length - 40), doc.length),
    };
  });
}

export async function waitDoc(page: Page, done: (doc: EditorDoc) => boolean): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!done(await editorDoc(page))) {
    if (Date.now() > deadline)
      throw new Error(`editor never reached the expected text: ${JSON.stringify(await editorDoc(page))}`);
    await page.waitForTimeout(POLL_MS);
  }
}

export function resultState(page: Page) {
  return page.getByTestId("result-state");
}

export async function waitResultState(page: Page, pattern: RegExp): Promise<void> {
  await expect
    .poll(async () => (await resultState(page).textContent()) ?? "", { timeout: STEP_TIMEOUT_MS, interval: POLL_MS })
    .toMatch(pattern);
}

/** Scrolls the result grid to its end and waits until row `last` is drawn. */
export async function scrollGridTo(page: Page, last: number): Promise<void> {
  const grid = page.getByRole("grid");
  await grid.evaluate((g: Scrollable) => {
    g.scrollTop = g.scrollHeight;
  });
  await expect
    .poll(
      () =>
        grid.evaluate((g: Scrollable) =>
          Math.max(
            -1,
            ...Array.from(g.querySelectorAll('[role="gridcell"][data-row]'), (c) => Number(c.getAttribute("data-row"))),
          ),
        ),
      { timeout: STEP_TIMEOUT_MS, interval: POLL_MS },
    )
    .toBe(last);
}

/** Characters held in DOM attributes: a long statement copied into a label shows up here. */
export function domAttributeChars(page: Page): Promise<number> {
  return page.evaluate(() =>
    Array.from((globalThis as unknown as { document: PageDocument }).document.querySelectorAll("*")).reduce(
      (n, e) => n + Array.from(e.attributes).reduce((m, a) => m + a.value.length, 0),
      0,
    ),
  );
}

export function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
    } catch {
      // Chromium removes its singleton files while we walk.
    }
  }
  return total;
}

export type StepAction = () => Promise<Record<string, unknown> | void>;

/**
 * A report written to `<PERF_OUTPUT_DIR>/<name>.json` after every step, so a failed run keeps the
 * steps before it. `step` times the action, then lets the app settle before reading the probe.
 */
export function perfReport(running: RunningApp, name: string, header: Record<string, unknown>) {
  const { app, page } = running;
  const steps: Record<string, unknown> = {};
  const report: Record<string, unknown> = { ...header, steps };
  mkdirSync(PERF_OUTPUT_DIR, { recursive: true });
  const save = () => writeFileSync(join(PERF_OUTPUT_DIR, `${name}.json`), JSON.stringify(report, null, 2));
  return {
    report,
    save,
    screenshot: (shot: string) => page.screenshot({ path: join(PERF_OUTPUT_DIR, `${name}-${shot}.png`) }),
    step: async (label: string, action: StepAction, settleMs = 1_500): Promise<void> => {
      await takeKeys(page);
      const wallFrom = Date.now();
      const pageFrom = await page.evaluate<number>("performance.now()");
      const extra = (await action()) ?? {};
      const ms = Date.now() - wallFrom;
      const keys = await takeKeys(page);
      await page.waitForTimeout(settleMs);
      const pageTo = await page.evaluate<number>("performance.now()");
      steps[label] = {
        ms,
        ...extra,
        ...(keys.keys > 0 ? keys : {}),
        renderer: await rendererStats(page, pageFrom, pageTo),
        processes: await processStats(app, wallFrom, Date.now()),
      };
      save();
      console.log(label, JSON.stringify(steps[label]));
    },
  };
}
