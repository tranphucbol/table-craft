/**
 * The OpenCode TUI in a Warp window beside the app, for the agent GIF that shows both sides at once
 * (decision 036). Warp opens the window from a launch configuration; ffmpeg's AVFoundation input
 * films the screen where it stands, while the app's own frames still come from its screencast,
 * so a notification over the app or a covered window never reaches the GIF. macOS only: it needs
 * Warp, and Screen Recording allowed for the terminal running the suite.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "playwright-core";
import {
  alignedLists,
  type Frame,
  GIF_FPS,
  GIF_PALETTE,
  type Recording,
  startScreencast,
  writeGif,
} from "./recorder.js";

const runCommand = promisify(execFile);

const WARP_HOME = join(homedir(), ".warp");
const WARP_SETTINGS = join(WARP_HOME, "settings.toml");
const LAUNCH_CONFIG = join(WARP_HOME, "launch_configurations", "table-craft-readme.yaml");
/** Warp opens a launch configuration by its name, not its file. */
const LAUNCH_NAME = "TableCraft README";
const WARP_MISSING = "Install Warp (https://www.warp.dev) and run it once to record the Warp agent GIF.";
const WARP_OWNER = "Warp";

const COLUMNS = 74;
const ROWS = 40;
/**
 * What the recording changes in Warp's settings, which Warp reloads as the file changes: a window
 * of a known size, opaque, without the vertical tab panel or the toolbar Warp adds under a CLI agent.
 */
const SETTINGS_PATCH: readonly (readonly [table: string, key: string, value: string])[] = [
  ["appearance.window", "open_windows_at_custom_size", "true"],
  ["appearance.window", "new_windows_num_columns", String(COLUMNS)],
  ["appearance.window", "new_windows_num_rows", String(ROWS)],
  ["appearance.window", "override_opacity", "100"],
  ["appearance.vertical_tabs", "enabled", "false"],
  ["agents.third_party", "should_render_cli_agent_toolbar", "false"],
  ["agents.warp_agent.other", "should_render_use_agent_toolbar_for_user_commands", "false"],
];
const SETTINGS_RELOAD_MS = 1_500;
const WINDOW_TIMEOUT_MS = 20_000;
const WINDOW_POLL_MS = 250;
const LAUNCH_RETRY_MS = 5_000;
const GO_FILE = ".go";
/** From `start` until the TUI covers the command Warp echoes; the GIF begins there. */
const TUI_START_SECONDS = 2;
const PID_FILE = ".pid";

/** The width of the side-by-side GIF; wider than the app's alone, as it holds two windows. */
const SIDE_BY_SIDE_WIDTH_PX = 1280;
const CAPTURE_FPS = 15;
/** A frame is dropped while fewer than this share of its 8×8 blocks changed since the last one kept. */
const DECIMATE = "mpdecimate=hi=99999:lo=64*6:frac=0.003";
/**
 * Rows of the window, in points, that change while nothing happens: `[top, height]`, a negative
 * top counting from the bottom.
 */
const MASKED_ROWS: readonly (readonly [top: number, height: number])[] = [
  [36, 24],
  [-45, 45],
];
const OUTPUT_BUFFER_BYTES = 64 * 1024 * 1024;
const CAPTURE_START = /start: (\d+\.\d+)/;
const SHOWN_FRAME = /pts_time:([\d.]+)/;

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function requireWarp(): void {
  if (process.platform !== "darwin" || !existsSync(WARP_SETTINGS)) throw new Error(WARP_MISSING);
}

/** `text` with `key = value` set in `[table]`, adding the key or the table when missing. */
export function setTomlKey(text: string, table: string, key: string, value: string): string {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (header < 0) return `${text.replace(/\n*$/, "")}\n\n[${table}]\n${key} = ${value}\n`;
  const end = lines.findIndex((line, index) => index > header && line.trimStart().startsWith("["));
  const section = lines.slice(header + 1, end < 0 ? lines.length : end);
  const at = section.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (at >= 0) lines[header + 1 + at] = `${key} = ${value}`;
  else lines.splice(header + 1, 0, `${key} = ${value}`);
  return lines.join("\n");
}

/** A shell word for `value`, so a prompt's apostrophe survives the launch configuration. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Warp's windows on screen, from Quartz, which needs no Accessibility permission. */
const WINDOWS_SCRIPT = `ObjC.import("CoreGraphics");
const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
JSON.stringify(all.filter((w) => w.kCGWindowOwnerName === ${JSON.stringify(WARP_OWNER)} && w.kCGWindowLayer === 0)
  .map((w) => ({ id: w.kCGWindowNumber, x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y,
    width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));`;
const SCALE_SCRIPT = `ObjC.import("AppKit"); $.NSScreen.mainScreen.backingScaleFactor`;

interface WarpWindowInfo extends Bounds {
  readonly id: number;
}

async function jxa(script: string): Promise<string> {
  const { stdout } = await runCommand("osascript", ["-l", "JavaScript", "-e", script]);
  return stdout.trim();
}

async function warpWindows(): Promise<WarpWindowInfo[]> {
  return JSON.parse(await jxa(WINDOWS_SCRIPT)) as WarpWindowInfo[];
}

export interface WarpTerminal {
  readonly bounds: Bounds;
  /** Lets the waiting window start `opencode`. */
  start(): void;
  /** When `start` ran, in seconds since the epoch. */
  startedAt(): number | null;
  /** Closes the window and puts Warp's settings back. */
  close(): void;
}

/**
 * Opens a Warp window in `folder` that waits for `start()` and then runs the OpenCode TUI on
 * `prompt`, which the TUI sends at once. The wait keeps the prompt from going out before the
 * recording starts.
 */
export async function openWarp(folder: string, prompt: string): Promise<WarpTerminal> {
  const settings = readFileSync(WARP_SETTINGS, "utf8");
  const restore = () => {
    writeFileSync(WARP_SETTINGS, settings);
    rmSync(LAUNCH_CONFIG, { force: true });
  };
  try {
    const command =
      `echo $$ > ${PID_FILE}; clear; while [ ! -e ${GO_FILE} ]; do sleep 0.05; done; ` +
      `exec opencode --standalone --auto --prompt ${quoted(prompt)}`;
    mkdirSync(join(WARP_HOME, "launch_configurations"), { recursive: true });
    writeFileSync(
      LAUNCH_CONFIG,
      [
        "---",
        `name: ${LAUNCH_NAME}`,
        "windows:",
        "  - tabs:",
        "      - title: opencode",
        "        layout:",
        `          cwd: ${JSON.stringify(folder)}`,
        "          commands:",
        `            - exec: ${JSON.stringify(command)}`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      WARP_SETTINGS,
      SETTINGS_PATCH.reduce((text, [table, key, value]) => setTomlKey(text, table, key, value), settings),
    );
    await new Promise((settle) => setTimeout(settle, SETTINGS_RELOAD_MS));
    const before = new Set((await warpWindows()).map((window) => window.id));
    const bounds = await newWindow(before);
    let startedAt: number | null = null;
    return {
      bounds,
      start: () => {
        startedAt = Date.now() / 1000;
        writeFileSync(join(folder, GO_FILE), "");
      },
      startedAt: () => startedAt,
      close: () => {
        try {
          const pid = Number(readFileSync(join(folder, PID_FILE), "utf8"));
          if (Number.isInteger(pid) && pid > 0) process.kill(pid);
        } catch {
          // The window is gone already, or never ran the command.
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * Asks Warp for the launch configuration's window and answers where it stands, once two looks
 * agree. Warp reads a new configuration file a moment after it appears and ignores a request for
 * one it has not read, and a busy Warp drops it, so an unanswered request is repeated.
 */
async function newWindow(before: ReadonlySet<number>): Promise<Bounds> {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  let asked = 0;
  let last = "";
  while (Date.now() < deadline) {
    if (last === "" && Date.now() - asked > LAUNCH_RETRY_MS) {
      // A busy Warp times the request out (-1712); the next try asks again.
      spawnSync("open", [`warp://launch/${encodeURIComponent(LAUNCH_NAME)}`], { stdio: "ignore" });
      asked = Date.now();
    }
    const opened = (await warpWindows()).find((window) => !before.has(window.id));
    if (opened !== undefined) {
      const { x, y, width, height } = opened;
      const seen = JSON.stringify({ x, y, width, height });
      if (seen === last) return { x, y, width, height };
      last = seen;
    }
    await new Promise((settle) => setTimeout(settle, WINDOW_POLL_MS));
  }
  throw new Error(`Warp opened no window for the launch configuration "${LAUNCH_NAME}" in time.`);
}

/** Puts the app's window right of `beside`, its content as tall as `beside`, within the screen. */
export async function placeBeside(app: ElectronApplication, beside: Bounds, gap: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, screen }, { beside, gap }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const area = screen.getPrimaryDisplay().workArea;
      const x = beside.x + beside.width + gap;
      window?.setContentBounds({ x, y: beside.y, width: area.x + area.width - x, height: beside.height });
    },
    { beside, gap },
  );
}

const capturing = new Set<ChildProcess>();

/** Ends any screen capture a failed scene left running. */
export function endCaptures(): void {
  for (const ffmpeg of capturing) ffmpeg.kill();
  capturing.clear();
}

interface ScreenCapture {
  stop(): Promise<{ readonly frames: readonly Frame[]; readonly directory: string }>;
}

/** Films `bounds` of the main screen with ffmpeg until `stop`, each kept frame timed by the wall clock. */
async function captureScreen(bounds: Bounds): Promise<ScreenCapture> {
  const scale = Number(await jxa(SCALE_SCRIPT));
  const pixels = (points: number) => Math.round((points * scale) / 2) * 2;
  const directory = mkdtempSync(join(tmpdir(), "table-craft-readme-screen-"));
  const movie = join(directory, "screen.mkv");
  const crop = `crop=${String(pixels(bounds.width))}:${String(pixels(bounds.height))}:${String(pixels(bounds.x))}:${String(pixels(bounds.y))}`;
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-y", "-f", "avfoundation", "-capture_cursor", "0", "-framerate", String(CAPTURE_FPS)],
      ...["-pixel_format", "bgr0", "-use_wallclock_as_timestamps", "1", "-i", "Capture screen 0:none"],
      ...["-vf", crop, "-c:v", "ffv1", movie],
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  capturing.add(ffmpeg);
  let log = "";
  const started = new Promise<number>((settle, fail) => {
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const start = CAPTURE_START.exec(log);
      if (start !== null && log.includes("frame=")) settle(Number(start[1]));
    });
    ffmpeg.on("exit", () => fail(new Error(`Screen capture ended early; allow Screen Recording.\n${log}`)));
  });
  const exited = new Promise<void>((settle) =>
    ffmpeg.on("exit", () => {
      capturing.delete(ffmpeg);
      settle();
    }),
  );
  const startSeconds = await started;
  return {
    async stop() {
      ffmpeg.stdin.end("q");
      await exited;
      try {
        return { directory, frames: await keptFrames(movie, directory, scale, startSeconds) };
      } finally {
        rmSync(movie, { force: true });
      }
    },
  };
}

function showinfoTimes(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => (line.includes("Parsed_showinfo") ? SHOWN_FRAME.exec(line)?.[1] : undefined))
    .filter((time) => time !== undefined);
}

/**
 * The frames of `movie` that show something new, at the window's size in points. The OpenCode TUI
 * never holds still: a spinner and a shimmering title in its top row, a progress bar and counters
 * in its bottom one. Masked out, they no longer count as change, so the time a model thinks holds
 * one frame that `maxFrameSeconds` can shorten.
 */
async function keptFrames(movie: string, directory: string, scale: number, startSeconds: number): Promise<Frame[]> {
  const mask = MASKED_ROWS.map(
    ([top, height]) =>
      `drawbox=x=0:y=${top < 0 ? `ih-${String(-top * scale)}` : String(top * scale)}:w=iw:h=${String(height * scale)}:color=black:t=fill`,
  ).join(",");
  const decided = await runCommand(
    "ffmpeg",
    ["-v", "info", "-i", movie, "-vf", `${mask},${DECIMATE},showinfo`, "-f", "null", "-"],
    {
      maxBuffer: OUTPUT_BUFFER_BYTES,
    },
  );
  const kept = new Set(showinfoTimes(decided.stderr));
  const frames = join(directory, "frames");
  mkdirSync(frames);
  const extracted = await runCommand(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      movie,
      "-vf",
      `scale=iw/${String(scale)}:-2:flags=area,showinfo`,
      "-fps_mode",
      "passthrough",
      join(frames, "%05d.png"),
    ],
    { maxBuffer: OUTPUT_BUFFER_BYTES },
  );
  const files = readdirSync(frames).sort();
  return showinfoTimes(extracted.stderr).flatMap((time, index) => {
    const file = files[index];
    return file === undefined || !kept.has(time)
      ? []
      : [{ file: join(frames, file), timestamp: startSeconds + Number(time) }];
  });
}

/**
 * Records `terminal` from the screen and the app from its screencast, side by side on one
 * timeline from the moment the TUI shows: the terminal left, the app right, at the terminal's height.
 */
export async function recordBeside(app: ElectronApplication, page: Page, terminal: WarpTerminal): Promise<Recording> {
  const screen = await captureScreen(terminal.bounds);
  const screencast = await startScreencast(app, page);
  const recorded = Date.now() / 1000;
  return {
    async stop(name, maxFrameSeconds) {
      const endSeconds = Date.now() / 1000;
      const started = terminal.startedAt();
      const startSeconds = started === null ? recorded : started + TUI_START_SECONDS;
      const window = await screencast.stop(name);
      const filmed = await screen.stop();
      try {
        const lists = alignedLists([filmed.frames, window.frames], startSeconds, endSeconds, maxFrameSeconds);
        const files = lists.map((list, index) => {
          const file = join(window.directory, `side-${String(index)}.ffconcat`);
          writeFileSync(file, list.script);
          return file;
        });
        const height = terminal.bounds.height;
        const filter =
          `[0:v]scale=-2:${String(height)}:flags=lanczos,setsar=1[terminal];` +
          `[1:v]scale=-2:${String(height)}:flags=lanczos,setsar=1[app];` +
          `[terminal][app]hstack=inputs=2,fps=${String(GIF_FPS)},` +
          `scale=${String(SIDE_BY_SIDE_WIDTH_PX)}:-2:flags=lanczos,${GIF_PALETTE}`;
        const path = writeGif(name, window.directory, files, filter);
        return { path, bytes: statSync(path).size, seconds: lists[0]?.seconds ?? 0 };
      } finally {
        rmSync(window.directory, { recursive: true, force: true });
        rmSync(filmed.directory, { recursive: true, force: true });
      }
    },
  };
}
