/**
 * Plan 020's local release: an HTTP server on loopback that serves a signed update manifest, its
 * signature and one asset, and the update log lines a launched app writes. The development smoke
 * suite and the packaged live test share it; the key is generated per run and never leaves it.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { LAUNCH_TIMEOUT_MS, mainToolbar, readProfileFile } from "./harness.js";

/** `UPDATE_OVERRIDE_ENV` in `main/update/overrides.ts`; the e2e suites do not import main. */
const MANIFEST_URL_ENV = "TABLE_CRAFT_UPDATE_MANIFEST_URL";
const BETA_MANIFEST_URL_ENV = "TABLE_CRAFT_UPDATE_BETA_MANIFEST_URL";
const PUBLIC_KEY_ENV = "TABLE_CRAFT_UPDATE_PUBLIC_KEY";
const FIRST_CHECK_ENV = "TABLE_CRAFT_UPDATE_FIRST_CHECK_MS";
export const FIRST_CHECK_MS = 300;
export const MANIFEST_PATH = "/releases/latest/download/update-manifest.json";
const SIGNATURE_PATH = `${MANIFEST_PATH}.sig`;
export const BETA_MANIFEST_PATH = "/update-channels/beta/update-manifest.json";
const BETA_SIGNATURE_PATH = `${BETA_MANIFEST_PATH}.sig`;
const UPDATE_SCOPE = "update";
const LOG_FILE = join("logs", "table-craft.log");
const PUBLIC_KEY_FILE = "update-test-key.pem";
const ASSET_KEYS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"];
const NOTES_URL = "https://example.com/notes";

export interface KeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}
export const KEYS: KeyPair = generateKeyPairSync("ed25519");
export const OTHER_KEYS: KeyPair = generateKeyPairSync("ed25519");

/** Answers one request for the asset; `attempt` counts from 1, so a scenario can fail only the first. */
export type AssetResponder = (attempt: number, asset: Buffer, response: ServerResponse) => void;

export interface Release {
  readonly version: string;
  /** The asset the manifest names, hashes and sizes. */
  readonly asset: Buffer;
  readonly assetName?: string;
  readonly signedBy?: KeyPair;
  readonly respond?: AssetResponder;
  /** A beta version the beta channel's manifest offers beside `version`; without it that manifest is 404. */
  readonly beta?: string;
}

export interface LocalServer {
  readonly server: Server;
  readonly url: string;
  readonly betaUrl: string;
  readonly assetPath: string;
  readonly requests: string[];
}

function manifestOf(release: Release, version: string, assetUrl: string): Buffer {
  const asset = {
    url: assetUrl,
    size: release.asset.byteLength,
    sha256: createHash("sha256").update(release.asset).digest("hex"),
  };
  const assets = Object.fromEntries(ASSET_KEYS.map((key) => [key, asset]));
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      version,
      ...(version.includes("-beta.") ? { channel: "beta" } : {}),
      notesUrl: NOTES_URL,
      minimumVersion: null,
      assets,
    }),
  );
}

const sendWhole: AssetResponder = (_attempt, asset, response) => {
  response.writeHead(200, { "content-length": String(asset.byteLength) }).end(asset);
};

export async function serve(release: Release): Promise<LocalServer> {
  const requests: string[] = [];
  const assetPath = `/releases/download/v${release.version}/${release.assetName ?? `TableCraft-${release.version}.zip`}`;
  let origin = "";
  let attempts = 0;
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const signature = (body: Buffer): string =>
      sign(null, body, (release.signedBy ?? KEYS).privateKey).toString("base64");
    const body = manifestOf(release, release.version, `${origin}${assetPath}`);
    const betaBody = release.beta === undefined ? null : manifestOf(release, release.beta, `${origin}${assetPath}`);
    if (request.url === MANIFEST_PATH) response.end(body);
    else if (request.url === SIGNATURE_PATH) response.end(signature(body));
    else if (request.url === BETA_MANIFEST_PATH && betaBody !== null) response.end(betaBody);
    else if (request.url === BETA_SIGNATURE_PATH && betaBody !== null) response.end(signature(betaBody));
    else if (request.url === assetPath) {
      attempts += 1;
      (release.respond ?? sendWhole)(attempts, release.asset, response);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { server, url: `${origin}${MANIFEST_PATH}`, betaUrl: `${origin}${BETA_MANIFEST_PATH}`, assetPath, requests };
}

/** The launch variables that point a development or test build at `local`, trusting `KEYS`. */
export function overrides(local: LocalServer, userDataDir: string): Record<string, string> {
  const keyFile = join(userDataDir, PUBLIC_KEY_FILE);
  writeFileSync(keyFile, KEYS.publicKey.export({ type: "spki", format: "pem" }).toString());
  return {
    [MANIFEST_URL_ENV]: local.url,
    [BETA_MANIFEST_URL_ENV]: local.betaUrl,
    [PUBLIC_KEY_ENV]: keyFile,
    [FIRST_CHECK_ENV]: String(FIRST_CHECK_MS),
  };
}

export interface LoggedLine {
  readonly level: string;
  readonly scope: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export function logLines(userDataDir: string): readonly LoggedLine[] {
  return (readProfileFile(userDataDir, LOG_FILE) ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LoggedLine);
}

export function updateLines(userDataDir: string): readonly LoggedLine[] {
  return logLines(userDataDir).filter((line) => line.scope === UPDATE_SCOPE);
}

/** Waits for the `nth` (from 1) update log line with `msg` and returns it. */
export async function loggedUpdate(userDataDir: string, msg: string, nth = 1): Promise<LoggedLine> {
  const matching = (): readonly LoggedLine[] => updateLines(userDataDir).filter((line) => line.msg === msg);
  await expect.poll(() => matching().length, { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThanOrEqual(nth);
  const line = matching()[nth - 1];
  if (line === undefined) throw new Error(`no update log line "${msg}"`);
  return line;
}

export function updateButton(page: Page) {
  return page.getByTestId("update-button");
}

/** The accessible names of the main toolbar's right-hand group, in order. */
export async function rightGroupNames(page: Page): Promise<string[]> {
  return mainToolbar(page)
    .locator("button")
    .evaluateAll(
      (
        buttons: readonly { getAttribute(name: string): string | null; readonly textContent: string | null }[],
      ): string[] =>
        buttons.slice(-3).map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""),
    );
}
