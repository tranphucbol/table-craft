/**
 * The demo video's backgrounds as HTML pages, one frame each: a title card, or a clip's caption
 * above an empty window frame the clip is laid into. Colours follow the One Dark Pro Dark theme the
 * README media scenes pin.
 */
import type { CardShot, ClipShot } from "./storyboard.js";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const FRAME_BORDER_PX = 10;
const CARD_TITLE_PX = 96;

const STYLE = `
  :root { --canvas: #1e1f22; --panel: #2b2d30; --edge: #3d4046; --ink: #dfe1e5; --muted: #9da0a8; --accent: #78a6fb; }
  html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; color: var(--ink);
    background: radial-gradient(1400px 900px at 50% 0%, #2a2d35 0%, var(--canvas) 60%);
    font-family: -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", sans-serif; }
  .kicker { font-size: 22px; font-weight: 600; line-height: 1; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); }
  .title { font-weight: 700; letter-spacing: -0.01em; }
  .sub { color: var(--muted); }
  .caption { position: absolute; inset: 0 0 auto; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 12px; text-align: center; }
  .caption .title { font-size: 54px; }
  .caption .sub { font-size: 28px; }
  .frame { position: absolute; border-radius: 14px; background: var(--panel);
    box-shadow: 0 0 0 1px var(--edge), 0 30px 80px rgba(0, 0, 0, 0.55); }
  .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 22px; text-align: center; }
  .card img { width: 168px; height: 168px; filter: drop-shadow(0 20px 40px rgba(0, 0, 0, 0.5)); }
  .card .sub { font-size: 38px; max-width: 1500px; line-height: 1.35; }
  .pills { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 1500px; margin-top: 10px; }
  .pill { font-size: 26px; padding: 10px 22px; border-radius: 999px; background: var(--panel); box-shadow: 0 0 0 1px var(--edge); }
  .url { font: 600 40px/1 "SF Mono", Menlo, Consolas, monospace; color: var(--accent); margin-top: 18px; }
`;

function escaped(text: string): string {
  return text.replace(/[&<>"]/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/** A full-screen title card; `iconUrl` is the app's icon as a `data:` URL. */
export function cardPage(shot: CardShot, iconUrl: string): string {
  const pills = (shot.pills ?? []).map((pill) => `<span class="pill">${escaped(pill)}</span>`).join("");
  return page(`<div class="card">
    ${shot.logo === true ? `<img src="${iconUrl}" alt="">` : ""}
    ${shot.kicker === undefined ? "" : `<div class="kicker">${escaped(shot.kicker)}</div>`}
    <div class="title" style="font-size:${String(shot.titlePx ?? CARD_TITLE_PX)}px">${escaped(shot.title)}</div>
    <div class="sub">${escaped(shot.sub)}</div>
    ${pills === "" ? "" : `<div class="pills">${pills}</div>`}
    ${shot.url === undefined ? "" : `<div class="url">${escaped(shot.url)}</div>`}
  </div>`);
}

/** The caption in the top `captionPx`, and the window frame around `clip`, where the clip goes. */
export function clipPage(shot: ClipShot, captionPx: number, clip: Box): string {
  const frame = {
    left: clip.x - FRAME_BORDER_PX,
    top: clip.y - FRAME_BORDER_PX,
    width: clip.width + 2 * FRAME_BORDER_PX,
    height: clip.height + 2 * FRAME_BORDER_PX,
  };
  return page(`
    <div class="caption" style="height:${String(captionPx)}px">
      <div class="kicker">${escaped(shot.kicker)}</div>
      <div class="title">${escaped(shot.title)}</div>
      <div class="sub">${escaped(shot.sub)}</div>
    </div>
    <div class="frame" style="left:${String(frame.left)}px;top:${String(frame.top)}px;width:${String(frame.width)}px;height:${String(frame.height)}px"></div>`);
}
