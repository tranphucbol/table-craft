/**
 * `bun run demo:video` records the clips of `storyboard.ts` and cuts them, with title cards, into
 * `dist/demo-video/tablecraft-demo.mp4`: 1080p, 60 fps, a silent audio track so every site takes it.
 *
 *   bun run demo:video                               record every clip, then cut
 *   README_MEDIA=agents-warp bun run demo:video      re-record that clip, keep the others, then cut
 *   bun run demo:video -- --cut                      cut the clips already recorded
 *
 * Recording runs `readme:media` with `README_MEDIA_CLIPS`, so it needs what that needs: Docker,
 * ffmpeg, a display, and for the agent clips OpenCode signed in, Warp and Screen Recording. An agent
 * clip shows a real model at work: watch it before cutting, and re-record a take with a failed tool
 * call. Cutting needs ffmpeg and Google Chrome, which renders the cards.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { type Box, cardPage, clipPage } from "./pages.js";
import { type ClipShot, type Shot, STORYBOARD } from "./storyboard.js";

const ROOT = resolve(import.meta.dirname, "../..");
const OUTPUT = join(ROOT, "dist/demo-video");
const CLIPS = join(OUTPUT, "clips");
const SEGMENTS = join(OUTPUT, "segments");
const VIDEO = join(OUTPUT, "tablecraft-demo.mp4");
const ICON = join(ROOT, "packages/desktop/build/icon.png");
const CUT_FLAG = "--cut";

const WIDTH_PX = 1920;
const HEIGHT_PX = 1080;
const FPS = 60;
const CAPTION_PX = 200;
const SIDE_MARGIN_PX = 60;
const BOTTOM_MARGIN_PX = 40;
const CLIP_AREA: Box = {
  x: SIDE_MARGIN_PX,
  y: CAPTION_PX,
  width: WIDTH_PX - 2 * SIDE_MARGIN_PX,
  height: HEIGHT_PX - CAPTION_PX - BOTTOM_MARGIN_PX,
};
/** The clip's last frame stays this long, so its result can be read before the cross-fade. */
const HOLD_SECONDS = 1.2;
const CROSSFADE_SECONDS = 0.5;
const FADE_OUT_SECONDS = 0.8;
const ENCODING = ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const SILENCE = "anullsrc=channel_layout=stereo:sample_rate=48000";
const CHROME_MISSING = "Install Google Chrome: it renders the video's title cards.";

interface Segment {
  readonly file: string;
  readonly seconds: number;
}

function ffmpeg(args: readonly string[]): void {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

function probe(path: string): { width: number; height: number; seconds: number } {
  const [stream = "", format = ""] = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "csv=p=0", path],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const [width = 0, height = 0] = stream.split(",").map(Number);
  return { width, height, seconds: Number(format) };
}

function even(value: number): number {
  return Math.floor(value / 2) * 2;
}

/** Where a clip of `width` × `height` fits in `CLIP_AREA`, centred, its sides even for x264. */
function fitted(width: number, height: number): Box {
  const scale = Math.min(CLIP_AREA.width / width, CLIP_AREA.height / height);
  const box = { width: even(width * scale), height: even(height * scale) };
  return {
    ...box,
    x: even(CLIP_AREA.x + (CLIP_AREA.width - box.width) / 2),
    y: even(CLIP_AREA.y + (CLIP_AREA.height - box.height) / 2),
  };
}

function clipFile(shot: ClipShot): string {
  return join(CLIPS, `${shot.scene}.mkv`);
}

function clipShots(): ClipShot[] {
  return STORYBOARD.filter((shot): shot is ClipShot => shot.kind === "clip");
}

function record(): void {
  const scenes =
    process.env["README_MEDIA"] ??
    clipShots()
      .map((shot) => shot.scene)
      .join(",");
  const run = spawnSync("bun", ["run", "readme:media"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, README_MEDIA: scenes, README_MEDIA_CLIPS: CLIPS },
  });
  if (run.status !== 0) throw new Error("Recording the clips failed; see readme:media's output above.");
}

function requireClips(): void {
  const missing = clipShots().filter((shot) => !existsSync(clipFile(shot)));
  if (missing.length === 0) return;
  const names = missing.map((shot) => shot.scene).join(",");
  throw new Error(`No clip for ${names}; record it with README_MEDIA=${names} bun run demo:video.`);
}

async function cut(): Promise<void> {
  rmSync(SEGMENTS, { recursive: true, force: true });
  mkdirSync(SEGMENTS, { recursive: true });
  const iconUrl = `data:image/png;base64,${readFileSync(ICON).toString("base64")}`;
  const browser = await chromium.launch({ channel: "chrome" }).catch((error: unknown) => {
    throw new Error(CHROME_MISSING, { cause: error });
  });
  const segments: Segment[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH_PX, height: HEIGHT_PX }, deviceScaleFactor: 1 });
    for (const [index, shot] of STORYBOARD.entries()) segments.push(await segment(page, shot, index, iconUrl));
  } finally {
    await browser.close();
  }
  crossfade(segments);
}

/** Renders the shot's background, then encodes the card, or the clip laid into its frame. */
async function segment(page: Page, shot: Shot, index: number, iconUrl: string): Promise<Segment> {
  const png = join(SEGMENTS, `${String(index)}.png`);
  const file = join(SEGMENTS, `${String(index)}.mp4`);
  const render = async (html: string) => {
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: png });
  };
  if (shot.kind === "card") {
    await render(cardPage(shot, iconUrl));
    ffmpeg(["-loop", "1", "-t", String(shot.seconds), "-i", png, ...ENCODING, file]);
    return { file, seconds: shot.seconds };
  }
  const clip = clipFile(shot);
  const source = probe(clip);
  const box = fitted(source.width, source.height);
  await render(clipPage(shot, CAPTION_PX, box));
  ffmpeg([
    ...["-loop", "1", "-t", String(source.seconds + HOLD_SECONDS), "-i", png, "-i", clip],
    "-filter_complex",
    `[1:v]fps=${String(FPS)},scale=${String(box.width)}:${String(box.height)}:flags=lanczos,` +
      `tpad=stop_mode=clone:stop_duration=${String(HOLD_SECONDS)}[clip];` +
      `[0:v][clip]overlay=${String(box.x)}:${String(box.y)}:shortest=1`,
    ...ENCODING,
    file,
  ]);
  return { file, seconds: probe(file).seconds };
}

/**
 * Cross-fades the segments in order, fades the end out, and adds the silent track. The start
 * does not fade in: GitHub's player shows the first frame until play, and a fade makes it black.
 */
function crossfade(segments: readonly Segment[]): void {
  const filters: string[] = [];
  let previous = "[0:v]";
  let offset = 0;
  segments.slice(1).forEach((_, index) => {
    offset += (segments[index]?.seconds ?? 0) - CROSSFADE_SECONDS;
    const label = `[x${String(index)}]`;
    filters.push(
      `${previous}[${String(index + 1)}:v]xfade=transition=fade:duration=${String(CROSSFADE_SECONDS)}:offset=${offset.toFixed(3)}${label}`,
    );
    previous = label;
  });
  const total = offset + (segments.at(-1)?.seconds ?? 0);
  filters.push(
    `${previous}fade=t=out:st=${(total - FADE_OUT_SECONDS).toFixed(3)}:d=${String(FADE_OUT_SECONDS)}[video]`,
  );
  ffmpeg([
    ...segments.flatMap((segment) => ["-i", segment.file]),
    ...["-f", "lavfi", "-t", total.toFixed(3), "-i", SILENCE],
    ...["-filter_complex", filters.join(";"), "-map", "[video]", "-map", `${String(segments.length)}:a`],
    ...ENCODING,
    ...["-c:a", "aac", "-shortest", "-movflags", "+faststart", VIDEO],
  ]);
  console.log(`${VIDEO} (${total.toFixed(1)} s)`);
}

if (!process.argv.includes(CUT_FLAG)) record();
requireClips();
await cut();
