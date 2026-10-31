/**
 * The guide's Agents (MCP) GIFs: turning the server on and copying OpenCode's configuration, then
 * OpenCode at work on the demo shop, reading freely and asking before it writes. The second is the
 * real OpenCode CLI on a real model (`opencode.ts`), configured with what Settings copied; a
 * transcript drawn over the window shows what it called and said, the side of the conversation the
 * app's window does not hold. The third is the same run in the OpenCode TUI, in a Warp window filmed
 * beside the app (`warp.ts`, macOS only). Recorded by `bun run readme:media` like the others.
 */
import type { ElectronApplication, Page } from "playwright-core";
import { beforeAll, expect } from "vitest";
import { freePort } from "../e2e/mcpAgent.js";
import { chooseOption, findAction, LAUNCH_TIMEOUT_MS, optionValue, showServices } from "../e2e/harness.js";
import { callLine, EVENT_LOG, opencodeModel, OpencodeFolder, requireOpencode, resultLine } from "./opencode.js";
import { clickVisibly, pause, pointAt } from "./pace.js";
import { connect, datasourceRow, mediaSuite, PASSWORD, READ_PAUSE_MS, scene, SHOP } from "./scenes.js";
import { endCaptures, openWarp, placeBeside, recordBeside, requireWarp, type WarpTerminal } from "./warp.js";

const CLIENT = "OpenCode";
/** The name OpenCode's MCP client gives in `initialize`, which the app lists and remembers. */
const OPENCODE_CLIENT = "opencode";
const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;

const PROMPT = "In TableCraft's shop database, restock the products that are nearly sold out (stock under 5) to 50.";
/** A model thinks for seconds with nothing on screen moving; the GIF holds such a frame this long. */
const MAX_THINKING_SECONDS = 1;
const AGENT_SCENE_TIMEOUT_MS = 300_000;
const POLL_MS = 200;
/** Asking OpenCode whether its turn ended runs its CLI twice; often enough to end the GIF promptly. */
const FINISHED_POLL_MS = 1_000;
/** Between the terminal and the app's window, which the GIF shows apart anyway. */
const WINDOW_GAP = 4;
/** The write in the Services tree, where the app logs every call an agent made. */
const WRITE_SHOWN = /^UPDATE (public\.)?products/;

const TRANSCRIPT_ID = "readme-agent";
const TRANSCRIPT_LINES_ID = "readme-agent-lines";

type LineKind = "prompt" | "call" | "ok" | "wait" | "reply";

/**
 * Lines kept under the prompt. Short enough that the panel ends above the approval dialog, which
 * the window centres below it.
 */
const TRAIL_LINES = 4;
/** A model's answer wraps, up to this many lines, where a call stays on one. */
const REPLY_LINES = 3;

/**
 * The agent's side, drawn like the pointer and the chord badge of `pace.ts`: plain DOM the
 * recording injects, styled from the app's tokens so it reads as a panel beside the window's own.
 * A string, because the root program has no DOM lib.
 */
const TRANSCRIPT_SCRIPT = `(() => {
  if (document.getElementById(${JSON.stringify(TRANSCRIPT_ID)}) !== null) return;
  const panel = document.createElement("div");
  panel.id = ${JSON.stringify(TRANSCRIPT_ID)};
  panel.style.cssText = "position:fixed;right:16px;top:52px;width:500px;z-index:2147483646;pointer-events:none;" +
    "border:1px solid var(--tc-border);border-radius:8px;background:var(--tc-panel);color:var(--tc-ink);" +
    "box-shadow:0 8px 24px rgba(0,0,0,0.45);font:12.5px/1.5 var(--tc-font-editor);overflow:hidden";
  panel.innerHTML = '<div style="display:flex;gap:8px;align-items:center;padding:6px 10px;' +
    'border-bottom:1px solid var(--tc-border);background:var(--tc-raised);font:600 12px var(--tc-font-ui)">' +
    '<span style="width:8px;height:8px;border-radius:50%;background:var(--tc-accent)"></span>' +
    '${CLIENT}<span style="font-weight:400;color:var(--tc-ink-muted)">· ${opencodeModel()}</span></div>' +
    '<div id=${JSON.stringify(TRANSCRIPT_LINES_ID)} style="display:flex;flex-direction:column;gap:3px;padding:6px 10px"></div>';
  document.body.append(panel);
})()`;

const LINE_STYLE: Readonly<Record<LineKind, { readonly mark: string; readonly color: string }>> = {
  prompt: { mark: "›", color: "var(--tc-accent)" },
  call: { mark: "⚙", color: "var(--tc-ink-muted)" },
  ok: { mark: "✓", color: "var(--tc-success)" },
  wait: { mark: "…", color: "var(--tc-warning)" },
  reply: { mark: "●", color: "var(--tc-ink)" },
};

async function say(page: Page, kind: LineKind, text: string): Promise<void> {
  await page.evaluate(TRANSCRIPT_SCRIPT);
  const { mark, color } = LINE_STYLE[kind];
  await page.evaluate(`(() => {
    const lines = document.getElementById(${JSON.stringify(TRANSCRIPT_LINES_ID)});
    const line = document.createElement("div");
    line.style.cssText = "display:flex;gap:8px;white-space:nowrap";
    const mark = document.createElement("span");
    mark.textContent = ${JSON.stringify(mark)};
    mark.style.color = ${JSON.stringify(color)};
    const text = document.createElement("span");
    text.textContent = ${JSON.stringify(text)};
    text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis";
    if (${JSON.stringify(kind)} === "wait") text.style.color = ${JSON.stringify(color)};
    if (${JSON.stringify(kind)} === "reply") {
      line.style.whiteSpace = "normal";
      text.style.cssText += ";display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${String(REPLY_LINES)}";
    }
    if (${JSON.stringify(kind)} === "prompt") text.style.fontWeight = "600";
    else line.dataset.trail = "";
    line.append(mark, text);
    lines.append(line);
    const trail = lines.querySelectorAll("[data-trail]");
    for (let index = 0; index < trail.length - ${String(TRAIL_LINES)}; index += 1) trail[index].remove();
  })()`);
}

function chip(page: Page) {
  return page.getByTestId("status-mcp");
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

/** OpenCode's configuration as Settings › MCP Server copies it, token and all, read off camera. */
async function copiedConfig(app: ElectronApplication, page: Page): Promise<string> {
  await findAction(page, "MCP Server Settings");
  const dialog = settingsDialog(page);
  await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await dialog.getByRole("group", { name: "MCP client" }).getByRole("button", { name: CLIENT }).click();
  await dialog.getByTestId("mcp-copy-config").click();
  await expect.poll(() => dialog.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  if (!TOKEN_PATTERN.test(copied)) throw new Error("The copied configuration holds no token.");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  return copied;
}

mediaSuite("README agent media", () => {
  let port = 0;
  beforeAll(async () => {
    port = await freePort();
  });

  scene("agents-setup", {
    settings: () => ({ mcp: { enabled: false, port, clients: [] } }),
    setup: () => Promise.resolve(),
    run: async ({ page }) => {
      await clickVisibly(
        page,
        page
          .getByRole("navigation", { name: "Right tool window stripe" })
          .getByRole("button", { name: "MCP Server Settings…" }),
      );
      const dialog = settingsDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, dialog.getByRole("switch", { name: "Let AI agents reach TableCraft" }));
      await expect
        .poll(() => dialog.getByTestId("mcp-state").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Running");
      await pointAt(page, dialog.getByTestId("mcp-endpoint"));
      await pause(page);
      await clickVisibly(page, dialog.getByRole("group", { name: "MCP client" }).getByRole("button", { name: CLIENT }));
      const snippet = dialog.getByTestId("mcp-client-config");
      await expect.poll(() => snippet.textContent()).toContain('"type": "remote"');
      await pointAt(page, snippet);
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, dialog.getByTestId("mcp-copy-config"));
      await expect.poll(() => dialog.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
      await pause(page);
      const access = dialog.getByLabel(`AI agent access for ${SHOP}`, { exact: true });
      await access.scrollIntoViewIfNeeded();
      await pointAt(page, access);
      await chooseOption(access, "ask");
      await expect.poll(() => optionValue(access)).toBe("ask");
      await pause(page, READ_PAUSE_MS);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      const badge = datasourceRow(page, SHOP).getByTestId("agent-access-badge");
      await badge.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pointAt(page, badge);
      await pause(page);
      await pointAt(page, chip(page));
    },
  });

  let folder: OpencodeFolder | null = null;
  scene("agents-approval", {
    shop: { agentAccess: "ask" },
    settings: () => ({ mcp: { enabled: true, port, clients: [{ name: OPENCODE_CLIENT, allowed: true }] } }),
    maxFrameSeconds: MAX_THINKING_SECONDS,
    timeoutMs: AGENT_SCENE_TIMEOUT_MS,
    setup: async ({ app, page }) => {
      requireOpencode();
      await expect.poll(() => chip(page).isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await connect(page, SHOP, PASSWORD);
      folder = new OpencodeFolder(await copiedConfig(app, page));
    },
    teardown: async () => {
      await folder?.dispose();
      folder = null;
    },
    run: async ({ page }) => {
      await say(page, "prompt", PROMPT);
      let shown = Promise.resolve();
      const show = (kind: LineKind, line: string) => {
        shown = shown.then(() => say(page, kind, line));
      };
      const agent = folder!.run(PROMPT, (event) => {
        if (event.kind === "error") show("wait", event.message);
        else if (event.kind === "text") show("reply", event.text);
        else {
          show("call", callLine(event.tool, event.input));
          show(event.failed ? "wait" : "ok", resultLine(event.output));
        }
      });
      try {
        const approvals = await approveWrites(page, agent.running, async () => {
          await shown;
          await say(page, "wait", "tablecraft.run_query is waiting for approval in TableCraft");
        });
        expect(await agent.exited, `OpenCode failed; its events are in ${EVENT_LOG}`).toBe(0);
        await shown;
        expect(approvals, `OpenCode never wrote; its events are in ${EVENT_LOG}`).toBeGreaterThan(0);
      } finally {
        agent.stop();
      }
      await showWrite(page);
    },
  });

  let terminal: WarpTerminal | null = null;
  scene("agents-warp", {
    shop: { agentAccess: "ask" },
    settings: () => ({ mcp: { enabled: true, port, clients: [{ name: OPENCODE_CLIENT, allowed: true }] } }),
    maxFrameSeconds: MAX_THINKING_SECONDS,
    timeoutMs: AGENT_SCENE_TIMEOUT_MS,
    setup: async ({ app, page }) => {
      requireOpencode();
      requireWarp();
      await expect.poll(() => chip(page).isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await connect(page, SHOP, PASSWORD);
      folder = new OpencodeFolder(await copiedConfig(app, page));
      terminal = await openWarp(folder.directory, PROMPT);
      await placeBeside(app, terminal.bounds, WINDOW_GAP);
    },
    record: ({ app, page }) => recordBeside(app, page, terminal!),
    teardown: async () => {
      endCaptures();
      terminal?.close();
      terminal = null;
      await folder?.dispose();
      folder = null;
    },
    run: async ({ page }) => {
      terminal!.start();
      let checked = 0;
      const working = async () => {
        if (Date.now() - checked < FINISHED_POLL_MS) return true;
        checked = Date.now();
        return !(await folder!.finished());
      };
      const approvals = await approveWrites(page, working);
      expect(approvals, "OpenCode never wrote; see its window").toBeGreaterThan(0);
      await showWrite(page);
    },
  });
});

/**
 * Allows every write the agent asks for while `working` holds, opening the first one's plan first,
 * and answers how many there were.
 */
async function approveWrites(
  page: Page,
  working: () => boolean | Promise<boolean>,
  beforeEach?: () => Promise<void>,
): Promise<number> {
  let approvals = 0;
  while (await working()) {
    if ((await chip(page).getAttribute("data-tone")) !== "waiting") {
      await page.waitForTimeout(POLL_MS);
      continue;
    }
    await beforeEach?.();
    await pointAt(page, chip(page));
    await clickVisibly(page, chip(page));
    const approval = page.getByTestId("mcp-approval");
    await approval.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await pause(page, READ_PAUSE_MS);
    if (approvals === 0) {
      await clickVisibly(page, approval.getByTestId("mcp-approval-view").getByRole("button", { name: "Plan" }));
      await approval.getByTestId("mcp-approval-plan").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
    }
    await clickVisibly(page, approval.getByTestId("mcp-allow"));
    await approval.waitFor({ state: "detached" });
    approvals += 1;
  }
  return approvals;
}

/** Ends on the write in the Services tree, where the app logs every call an agent made. */
async function showWrite(page: Page): Promise<void> {
  const write = (await showServices(page)).getByText(WRITE_SHOWN).first();
  await write.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await pause(page, READ_PAUSE_MS);
  await pointAt(page, write);
  await pause(page, READ_PAUSE_MS);
}
