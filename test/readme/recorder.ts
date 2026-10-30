/**
 * Records the app's window into a README GIF (decision 036): a CDP screencast of the page, one PNG
 * per painted frame with its timestamp, turned into a GIF by ffmpeg with a palette built from the
 * frames themselves. A screencast rather than Playwright's `recordVideo`, because the video is a
 * lossy VP8 at a fixed bitrate and small text smears; the screencast's PNGs are the pixels painted.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CDPSession, ElectronApplication, Page } from "playwright-core";

export const GIF_WIDTH_PX = 1100;
export const GIF_FPS = 12;
/** Decision 22 of plan 016: one GIF at most 2 MB; plan 128 raised the total from 18 MB to 24 MB. */
export const GIF_MAX_BYTES = 2 * 1024 * 1024;
export const GIFS_MAX_BYTES = 24 * 1024 * 1024;

export const MEDIA_DIRECTORY = resolve(import.meta.dirname, "../../docs/media");
const FRAMES_PREFIX = "table-craft-readme-frames-";
const CONCAT_LIST = "frames.ffconcat";
const FRAME_NAME_DIGITS = 5;
/** A frame painted right before `stop` still needs a visible duration, or ffmpeg drops it. */
const MIN_LAST_FRAME_SECONDS = 0.1;
const FFMPEG = "ffmpeg";
export const FFMPEG_MISSING = "Install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`) to record the README GIFs.";

/**
 * Bayer dithering with `diff_mode=rectangle` re-encodes only the changed rectangle of each frame,
 * which keeps a mostly static window small; `stats_mode=diff` builds the palette from what moves.
 */
export const GIF_PALETTE =
  "split[frames][copy];[copy]palettegen=stats_mode=diff[palette];" +
  "[frames][palette]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
const GIF_FILTER = `fps=${String(GIF_FPS)},scale=${String(GIF_WIDTH_PX)}:-1:flags=lanczos,${GIF_PALETTE}`;

export interface Frame {
  readonly file: string;
  /** Seconds, as CDP's `ScreencastFrameMetadata.timestamp`. */
  readonly timestamp: number;
}

export interface Gif {
  readonly path: string;
  readonly bytes: number;
  readonly seconds: number;
}

export interface Recording {
  /**
   * Stops the screencast and writes `docs/media/<name>.gif`. `maxFrameSeconds` shortens every
   * frame held longer, for a scene that waits on something outside the app, such as a model.
   */
  stop(name: string, maxFrameSeconds?: number): Promise<Gif>;
}

export interface ConcatList {
  readonly script: string;
  readonly seconds: number;
}

/**
 * The ffmpeg concat-demuxer script for `frames`: each frame lasts until the next one was painted,
 * the last until `endSeconds`, none longer than `maxFrameSeconds`. The last file is listed twice
 * because the demuxer ignores the duration of the final entry.
 */
export function concatList(frames: readonly Frame[], endSeconds: number, maxFrameSeconds = Infinity): ConcatList {
  const lines = ["ffconcat version 1.0"];
  let seconds = 0;
  frames.forEach((frame, index) => {
    const next = frames[index + 1]?.timestamp ?? Math.max(endSeconds, frame.timestamp + MIN_LAST_FRAME_SECONDS);
    const duration = Math.min(next - frame.timestamp, maxFrameSeconds);
    seconds += duration;
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(3)}`);
  });
  const last = frames.at(-1);
  if (last !== undefined) lines.push(`file '${last.file}'`);
  return { script: `${lines.join("\n")}\n`, seconds };
}

/**
 * Concat lists for several recordings of the same moment, one per source, on one timeline from
 * `startSeconds` to `endSeconds`: every source shows its latest frame at each instant, and a span in
 * which no source painted is held at most `maxFrameSeconds` in all of them alike, so they stay in
 * step. A source that painted nothing yet at `startSeconds` shows its first frame from the start.
 */
export function alignedLists(
  sources: readonly (readonly Frame[])[],
  startSeconds: number,
  endSeconds: number,
  maxFrameSeconds = Infinity,
): ConcatList[] {
  const inside = (time: number) => Math.min(Math.max(time, startSeconds), endSeconds);
  const instants = [...new Set([startSeconds, endSeconds, ...sources.flat().map((frame) => inside(frame.timestamp))])];
  instants.sort((a, b) => a - b);
  const shown = new Map<number, number>();
  instants.forEach((instant, index) => {
    const previous = instants[index - 1];
    const before =
      previous === undefined ? 0 : (shown.get(previous) ?? 0) + Math.min(instant - previous, maxFrameSeconds);
    shown.set(instant, before);
  });
  const at = (time: number) => shown.get(inside(time)) ?? 0;
  return sources.map((frames) => {
    const current = frames.filter(
      (frame, index) => frame.timestamp <= endSeconds && (frames[index + 1]?.timestamp ?? Infinity) > startSeconds,
    );
    const timed = current.map((frame, index) => ({
      file: frame.file,
      timestamp: index === 0 ? startSeconds : frame.timestamp,
    }));
    const lines = ["ffconcat version 1.0"];
    timed.forEach((frame, index) => {
      const next = timed[index + 1]?.timestamp ?? endSeconds;
      const duration = Math.max(at(next) - at(frame.timestamp), 0);
      if (duration > 0 || index === timed.length - 1)
        lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(3)}`);
    });
    const last = timed.at(-1);
    if (last !== undefined) lines.push(`file '${last.file}'`);
    return { script: `${lines.join("\n")}\n`, seconds: at(endSeconds) };
  });
}

/** Throws `FFMPEG_MISSING` when no `ffmpeg` runs from the PATH. */
export function requireFfmpeg(): void {
  const probe = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) throw new Error(FFMPEG_MISSING);
}

function frameName(index: number): string {
  return `frame-${String(index).padStart(FRAME_NAME_DIGITS, "0")}.png`;
}

/**
 * A window another window covers stops compositing on macOS: the DOM still changes, so the scene's
 * assertions pass, but no frame is painted and the GIF freezes on a stale picture. On top and
 * unthrottled, the window paints every change while it records.
 */
async function keepPainting(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setAlwaysOnTop(true, "floating");
    window?.webContents.setBackgroundThrottling(false);
  });
}

/** Repaints one near-transparent pixel, so a live screencast must deliver another frame. */
const NUDGE_SCRIPT = `(() => {
  let nudge = document.getElementById("readme-nudge");
  if (nudge === null) {
    nudge = document.createElement("div");
    nudge.id = "readme-nudge";
    nudge.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;pointer-events:none;background:#000;opacity:0.01";
    document.body.append(nudge);
  }
  nudge.style.opacity = nudge.style.opacity === "0.01" ? "0.02" : "0.01";
})()`;
const FRESH_FRAME_TIMEOUT_MS = 3_000;
const FRESH_FRAME_POLL_MS = 50;

async function waitForFreshFrame(page: Page, frames: readonly Frame[], name: string): Promise<void> {
  const before = frames.length;
  await page.evaluate(NUDGE_SCRIPT);
  const deadline = Date.now() + FRESH_FRAME_TIMEOUT_MS;
  while (frames.length === before) {
    if (Date.now() > deadline) {
      throw new Error(
        `Recording "${name}" stopped receiving frames; keep the app's window on screen while it records.`,
      );
    }
    await new Promise((settle) => setTimeout(settle, FRESH_FRAME_POLL_MS));
  }
}

export interface Screencast {
  /** Ends the screencast; the frames stay in `directory` until the caller removes it. */
  stop(name: string): Promise<{ readonly frames: readonly Frame[]; readonly directory: string }>;
}

export async function startScreencast(app: ElectronApplication, page: Page): Promise<Screencast> {
  await keepPainting(app);
  const directory = mkdtempSync(join(tmpdir(), FRAMES_PREFIX));
  const frames: Frame[] = [];
  const session: CDPSession = await app.context().newCDPSession(page);
  session.on("Page.screencastFrame", (event) => {
    const file = join(directory, frameName(frames.length));
    writeFileSync(file, Buffer.from(event.data, "base64"));
    frames.push({ file, timestamp: event.metadata.timestamp ?? Date.now() / 1000 });
    session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return {
    async stop(name) {
      try {
        await waitForFreshFrame(page, frames, name);
        await session.send("Page.stopScreencast");
        await session.detach().catch(() => undefined);
        if (frames.length === 0) throw new Error(`Recording "${name}" captured no frames; is the window visible?`);
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return { frames, directory };
    },
  };
}

/** Writes `docs/media/<name>.gif` from ffmpeg concat lists in `directory`, through `filter`. */
export function writeGif(name: string, directory: string, lists: readonly string[], filter: string): string {
  mkdirSync(MEDIA_DIRECTORY, { recursive: true });
  const path = join(MEDIA_DIRECTORY, `${name}.gif`);
  const inputs = lists.flatMap((list) => ["-f", "concat", "-safe", "0", "-i", list]);
  execFileSync(FFMPEG, ["-y", "-v", "error", ...inputs, "-filter_complex", filter, "-loop", "0", path], {
    cwd: directory,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return path;
}

export async function startRecording(app: ElectronApplication, page: Page): Promise<Recording> {
  const screencast = await startScreencast(app, page);
  return {
    async stop(name, maxFrameSeconds) {
      const endSeconds = Date.now() / 1000;
      const { frames, directory } = await screencast.stop(name);
      try {
        const list = concatList(frames, endSeconds, maxFrameSeconds);
        writeFileSync(join(directory, CONCAT_LIST), list.script);
        const path = writeGif(name, directory, [CONCAT_LIST], GIF_FILTER);
        return { path, bytes: statSync(path).size, seconds: list.seconds };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
