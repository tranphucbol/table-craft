/**
 * The updater (plan 020): checks the signed manifest, downloads and verifies the platform's asset,
 * stages it, and installs it only when asked. One state, pushed whole on every change.
 *
 * Electron-free: main hands it `net.fetch`, the process runners and the paths, so the whole state
 * machine runs under Vitest against a local key pair and a temp directory.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "@table-craft/desktop/log/record.js";
import {
  eligibility,
  INELIGIBLE_MESSAGES,
  type InstallFacts,
  type InstallTarget,
} from "@table-craft/desktop/main/update/eligibility.js";
import {
  assetKey,
  compareVersions,
  MANIFEST_FILE,
  SIGNATURE_FILE,
  verifyManifest,
  type ManifestRejection,
  type ManifestTrust,
  type UpdateAsset,
  type UpdateManifest,
} from "@table-craft/desktop/main/update/manifest.js";
import { SWAP_SCRIPT_FILE, swapScript } from "@table-craft/desktop/main/update/swap.js";
import type { UpdateRelease, UpdateState } from "@table-craft/desktop/preload/bridge.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";

export type CheckTrigger = "automatic" | "manual";

/** The slice of `net.fetch`'s answer the updater reads. */
export interface FetchedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<FetchedResponse>;

export interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

/** What the updater remembers between launches, in `update-state.json` beside the settings. */
export interface UpdateMemory {
  readonly skippedVersion: string | null;
}

export interface UpdaterOptions {
  readonly currentVersion: string;
  /** Where each channel's `update-manifest.json` is; its `.sig` is fetched from beside it. */
  readonly manifestUrls: Readonly<Record<ReleaseChannel, string>>;
  /** Read on every check, so a change in Settings applies to the next one without a restart. */
  readonly channel: () => ReleaseChannel;
  readonly trust: ManifestTrust;
  readonly facts: InstallFacts;
  /** For downloads that are not staged beside the app: the Windows installer and the macOS zip. */
  readonly tempDirectory: string;
  /** Where the swap script writes; main appends it to the log on the next launch. */
  readonly swapLogPath: string;
  readonly pid: number;
  /** The arguments this run started with, which the relaunched app gets too, as `app.relaunch` does. */
  readonly relaunchArgs: readonly string[];
  readonly fetch: Fetch;
  /** Runs a command to completion: `ditto` on macOS. */
  readonly run: (command: string, args: readonly string[]) => Promise<RunResult>;
  /** Starts a command that outlives TableCraft. */
  readonly spawnDetached: (command: string, args: readonly string[]) => void;
  readonly readMemory: () => Promise<UpdateMemory>;
  readonly writeMemory: (memory: UpdateMemory) => Promise<void>;
  readonly onState: (state: UpdateState) => void;
  readonly log: Logger;
  readonly newId: () => string;
}

export interface Updater {
  readonly state: () => UpdateState;
  readonly check: (trigger: CheckTrigger) => Promise<UpdateState>;
  readonly download: () => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly skip: () => Promise<void>;
  readonly dismiss: () => void;
  /** The offered release's notes page, for main to open; null when nothing is offered. */
  readonly notesUrl: () => string | null;
  /** Whether a staged update waits for {@link install}. */
  readonly ready: () => boolean;
  /**
   * Called as TableCraft quits after Restart to Update: hands the staged update to whatever
   * replaces the app once this process is gone. Returns how TableCraft should relaunch: `self`
   * for `app.relaunch()` with the given executable, `external` when the installer does it.
   */
  readonly install: () => Promise<InstallOutcome>;
  /** Removes whatever is staged; quitting without installing leaves nothing behind. */
  readonly discard: () => Promise<void>;
  /** Whether a download or a staged update has files on disk that quitting must install or remove. */
  readonly holdsFiles: () => boolean;
}

export type InstallOutcome =
  | { readonly relaunch: "external" }
  | { readonly relaunch: "self"; readonly executable: string }
  | { readonly relaunch: "none" };

/** Every update record carries this scope; `step` says which part of the flow wrote it. */
export const UPDATE_SCOPE = "update";
const MANIFEST_TIMEOUT_MS = 30_000;
const PROGRESS_STEP_MS = 100;
const MILESTONES = [25, 50, 75] as const;
const PERCENT = 100;
const STAGING_PREFIX = ".table-craft-update-";
const APP_BUNDLE_SUFFIX = ".app";
const MAC_EXECUTABLE_DIRECTORY = "Contents/MacOS";
const DITTO = "/usr/bin/ditto";
const SH = "/bin/sh";
const EXECUTABLE_MODE = 0o755;
/** electron-builder's NSIS: `/S` silent, `--updated` keeps the install, `--force-run` starts it after. */
const NSIS_ARGS = ["/S", "--updated", "--force-run"];
const ZIP_EXTENSION = ".zip";
const INSTALLER_EXTENSION = ".exe";

const CHECK_FAILED = "TableCraft could not reach the update server. Check your connection and try again.";
const REJECTED =
  "The update information could not be verified, so nothing was downloaded. Try again later, or download the release from GitHub.";
const UNPACKABLE = "The downloaded update could not be unpacked. Try again, or download the release from GitHub.";
const NOT_STAGEABLE =
  "The update could not be prepared next to TableCraft. Try again, or download the release from GitHub.";

/** Origin and path only: a signed asset redirect carries its token in the query (plan 017). */
export function loggableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(not a URL)";
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A sibling of `path` the updater owns, on the same volume so a rename is atomic. */
function besides(path: string, id: string, suffix = ""): string {
  return join(dirname(path), `${STAGING_PREFIX}${id}${suffix}`);
}

/** One manifest URL's answer to a check. */
type Fetched =
  | { readonly kind: "manifest"; readonly url: string; readonly manifest: UpdateManifest }
  | { readonly kind: "unreachable"; readonly url: string; readonly cause: unknown }
  | { readonly kind: "rejected"; readonly url: string; readonly reason: ManifestRejection; readonly detail: string }
  | { readonly kind: "otherChannel"; readonly url: string; readonly manifest: UpdateManifest };

/** A beta-channel app takes either kind; a stable one never takes a beta, wherever it was found. */
function channelAllows(channel: ReleaseChannel, manifest: UpdateManifest): boolean {
  return channel === "beta" || manifest.channel === "stable";
}

/** Leftovers from a crash or a power cut mid-download: staging directories beside the installed app. */
export async function removeLeftovers(target: InstallTarget, log: Logger): Promise<void> {
  const path =
    target.kind === "macBundle" ? target.bundlePath : target.kind === "appImage" ? target.appImagePath : null;
  if (path === null) return;
  let names: string[];
  try {
    names = await readdir(dirname(path));
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith(STAGING_PREFIX))) {
    await rm(join(dirname(path), name), { recursive: true, force: true });
    log.info("removed a leftover update", { path: join(dirname(path), name) });
  }
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { currentVersion: current, log } = options;
  const key = assetKey(options.facts.platform, options.facts.arch);
  let state: UpdateState = { phase: "idle", current };
  let manifest: UpdateManifest | null = null;
  let target: InstallTarget | null = null;
  /** The file the download wrote and, on macOS, the staging directory; removed on failure and on discard. */
  let staged: { readonly path: string; readonly directory: string | null } | null = null;
  let checking: Promise<UpdateState> | null = null;
  let downloadAbort: AbortController | null = null;

  function set(next: UpdateState): void {
    state = next;
    options.onState(next);
  }

  function releaseOf(offered: UpdateManifest): UpdateRelease {
    return { version: offered.version, size: offered.assets[key]?.size ?? 0 };
  }

  async function fetchBytes(url: string): Promise<Uint8Array> {
    const response = await options.fetch(url, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} from ${loggableUrl(url)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function fetchManifest(url: string, channel: ReleaseChannel): Promise<Fetched> {
    let body: Uint8Array;
    let signature: string;
    try {
      const signatureUrl = new URL(SIGNATURE_FILE, url.replace(/[^/]*$/, "")).href;
      [body, signature] = await Promise.all([
        fetchBytes(url),
        fetchBytes(signatureUrl).then((bytes) => new TextDecoder().decode(bytes)),
      ]);
    } catch (cause) {
      return { kind: "unreachable", url, cause };
    }
    const verdict = verifyManifest(body, signature, options.trust);
    if (!verdict.ok) return { kind: "rejected", url, reason: verdict.reason, detail: verdict.detail };
    if (!channelAllows(channel, verdict.manifest)) return { kind: "otherChannel", url, manifest: verdict.manifest };
    return { kind: "manifest", url, manifest: verdict.manifest };
  }

  /**
   * One state for a check no manifest answered. A bad signature outranks the rest; a manifest this
   * version cannot read (a later schema) would otherwise flag every old install on each automatic
   * check, so only a signature is worth the user's attention then.
   */
  function failedCheck(answers: readonly Fetched[], trigger: CheckTrigger, before: UpdateState): void {
    const rejections = answers.flatMap((answer) => (answer.kind === "rejected" ? [answer.reason] : []));
    if (rejections.includes("signature")) {
      set({ phase: "error", current, release: null, message: REJECTED, retryable: false });
    } else if (answers.some((answer) => answer.kind === "unreachable")) {
      if (trigger === "automatic") set(before.phase === "error" ? before : { phase: "idle", current });
      else set({ phase: "error", current, release: null, message: CHECK_FAILED, retryable: true });
    } else if (rejections.length > 0 && trigger === "manual") {
      set({ phase: "error", current, release: null, message: REJECTED, retryable: false });
    } else {
      set({ phase: "idle", current });
    }
  }

  async function runCheck(trigger: CheckTrigger): Promise<UpdateState> {
    const channel = options.channel();
    const checkLog = log.child(UPDATE_SCOPE, { step: "check", trigger, current, channel });
    const before = state;
    // Every two hours a `checking` push would hide a shown Update button and close its popover.
    if (trigger === "manual" || before.phase === "idle") set({ phase: "checking", current });
    const urls =
      channel === "beta" ? [options.manifestUrls.stable, options.manifestUrls.beta] : [options.manifestUrls.stable];
    checkLog.info("checking for updates", { urls: urls.map(loggableUrl) });
    const answers = await Promise.all(urls.map((url) => fetchManifest(url, channel)));
    for (const answer of answers) {
      const url = loggableUrl(answer.url);
      if (answer.kind === "unreachable") checkLog.warn("update check failed", { url, err: answer.cause });
      if (answer.kind === "rejected") {
        const fields = { url, reason: answer.reason, detail: answer.detail, file: MANIFEST_FILE };
        if (answer.reason === "signature") checkLog.error("update manifest rejected", fields);
        else checkLog.warn("update manifest rejected", fields);
      }
      if (answer.kind === "otherChannel")
        checkLog.warn("update manifest is for another channel", { url, manifestChannel: answer.manifest.channel });
    }
    const offered = answers
      .flatMap((answer) => (answer.kind === "manifest" ? [answer.manifest] : []))
      .reduce<UpdateManifest | null>(
        (best, next) => (best === null || compareVersions(next.version, best.version) > 0 ? next : best),
        null,
      );
    if (offered === null) {
      failedCheck(answers, trigger, before);
      return state;
    }
    const fields = { target: offered.version, targetChannel: offered.channel };
    if (compareVersions(offered.version, current) <= 0) {
      checkLog.info("up to date", fields);
      manifest = null;
      set({ phase: "idle", current });
      return state;
    }
    const memory = await options.readMemory().catch(() => ({ skippedVersion: null }));
    if (trigger === "automatic" && memory.skippedVersion === offered.version) {
      checkLog.info("newer version skipped by the user", fields);
      set({ phase: "idle", current });
      return state;
    }
    manifest = offered;
    const verdictHere = eligibility(options.facts, offered, key);
    if (!verdictHere.eligible) {
      checkLog.info("update found; this install cannot update itself", { ...fields, reason: verdictHere.reason });
      target = null;
      set({
        phase: "ineligible",
        current,
        release: releaseOf(offered),
        message: INELIGIBLE_MESSAGES[verdictHere.reason],
      });
      return state;
    }
    target = verdictHere.target;
    checkLog.info("update available", { ...fields, size: offered.assets[key]?.size, install: target.kind });
    set({ phase: "available", current, release: releaseOf(offered) });
    return state;
  }

  async function removeStaged(): Promise<void> {
    const leftover = staged;
    staged = null;
    if (leftover === null) return;
    await rm(leftover.directory ?? leftover.path, { recursive: true, force: true });
    if (leftover.directory !== null) await rm(leftover.path, { force: true });
  }

  /** Streams the asset to `path`, hashing as it goes; throws a `HashMismatch` when the bytes are not the signed ones. */
  async function fetchAsset(
    asset: UpdateAsset,
    path: string,
    signal: AbortSignal,
    release: UpdateRelease,
  ): Promise<void> {
    const downloadLog = log.child(UPDATE_SCOPE, { step: "download", current, target: release.version });
    const response = await options.fetch(asset.url, { signal });
    if (!response.ok || response.body === null)
      throw new Error(`HTTP ${String(response.status)} from ${loggableUrl(asset.url)}`);
    const hash = createHash("sha256");
    const file = await open(path, "w");
    let received = 0;
    let lastProgress = 0;
    let milestone = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > asset.size)
          throw new HashMismatch(`more than the ${String(asset.size)} bytes the manifest names`);
        hash.update(value);
        await file.write(value);
        const percent = Math.floor((received / asset.size) * PERCENT);
        while (milestone < MILESTONES.length && percent >= (MILESTONES[milestone] ?? PERCENT)) {
          downloadLog.info("download progress", { percent: MILESTONES[milestone], received });
          milestone += 1;
        }
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_STEP_MS) {
          lastProgress = now;
          set({ phase: "downloading", current, release, received, total: asset.size });
        }
      }
    } finally {
      await file.close();
    }
    const digest = hash.digest("hex");
    if (received !== asset.size)
      throw new HashMismatch(`${String(received)} bytes, the manifest names ${String(asset.size)}`);
    if (digest !== asset.sha256) throw new HashMismatch(`SHA-256 ${digest}, the manifest names ${asset.sha256}`);
  }

  async function stageMac(bundlePath: string, archive: string): Promise<string> {
    const directory = besides(bundlePath, options.newId());
    staged = { path: archive, directory };
    try {
      await mkdir(directory);
    } catch (cause) {
      throw new StageFailure(NOT_STAGEABLE, cause);
    }
    const unpacked = await options.run(DITTO, ["-x", "-k", archive, directory]);
    if (unpacked.code !== 0)
      throw new StageFailure(UNPACKABLE, new Error(`ditto exited ${String(unpacked.code)}: ${unpacked.output}`));
    await rm(archive, { force: true });
    const bundles = (await readdir(directory)).filter((name) => name.endsWith(APP_BUNDLE_SUFFIX));
    const [bundle] = bundles;
    if (bundle === undefined || bundles.length !== 1)
      throw new StageFailure(UNPACKABLE, new Error(`the archive holds ${String(bundles.length)} app bundles`));
    const executable = join(directory, bundle, MAC_EXECUTABLE_DIRECTORY, basename(options.facts.executablePath));
    try {
      await access(executable, constants.X_OK);
    } catch (cause) {
      throw new StageFailure(UNPACKABLE, cause);
    }
    return join(directory, bundle);
  }

  let stagedBundle: string | null = null;

  async function runDownload(): Promise<void> {
    if (state.phase !== "available" && !(state.phase === "error" && state.retryable && manifest !== null)) return;
    const offered = manifest;
    const installTo = target;
    const asset = offered?.assets[key];
    if (offered === null || installTo === null || asset === undefined) return;
    const release = releaseOf(offered);
    const downloadLog = log.child(UPDATE_SCOPE, { step: "download", current, target: offered.version });
    const abort = new AbortController();
    downloadAbort = abort;
    await removeStaged();
    const id = options.newId();
    const path =
      installTo.kind === "appImage"
        ? besides(installTo.appImagePath, id)
        : join(
            options.tempDirectory,
            `${STAGING_PREFIX}${id}${installTo.kind === "nsis" ? INSTALLER_EXTENSION : ZIP_EXTENSION}`,
          );
    staged = { path, directory: null };
    set({ phase: "downloading", current, release, received: 0, total: asset.size });
    downloadLog.info("download started", { url: loggableUrl(asset.url), size: asset.size, install: installTo.kind });
    try {
      await fetchAsset(asset, path, abort.signal, release);
      downloadLog.info("download verified", { sha256: asset.sha256 });
      if (installTo.kind === "macBundle") stagedBundle = await stageMac(installTo.bundlePath, path);
      if (installTo.kind === "appImage") await chmod(path, EXECUTABLE_MODE);
      downloadLog.info("update staged", { path: staged?.directory ?? path });
      set({ phase: "ready", current, release });
    } catch (cause) {
      await removeStaged();
      stagedBundle = null;
      if (abort.signal.aborted && !(cause instanceof HashMismatch)) {
        downloadLog.info("download cancelled");
        set({ phase: "available", current, release });
        return;
      }
      if (cause instanceof HashMismatch) {
        downloadLog.error("downloaded update does not match the manifest", { err: cause });
        set({
          phase: "error",
          current,
          release,
          message: `The download does not match the signed release: ${cause.message}. It was deleted; try again.`,
          retryable: true,
        });
      } else if (cause instanceof StageFailure) {
        downloadLog.error("update could not be staged", { err: cause.cause });
        set({ phase: "error", current, release, message: cause.message, retryable: true });
      } else {
        downloadLog.warn("download failed", { err: cause });
        set({
          phase: "error",
          current,
          release,
          message: `The download was interrupted (${describe(cause)}). Nothing was kept; try again.`,
          retryable: true,
        });
      }
    } finally {
      if (downloadAbort === abort) downloadAbort = null;
    }
  }

  function check(trigger: CheckTrigger): Promise<UpdateState> {
    if (checking !== null) return checking;
    if (state.phase === "downloading" || state.phase === "ready") return Promise.resolve(state);
    checking = runCheck(trigger).finally(() => {
      checking = null;
    });
    return checking;
  }

  return {
    state: () => state,
    check,
    async download() {
      if (state.phase === "error" && state.release === null) {
        if (state.retryable) await check("manual");
        return;
      }
      await runDownload();
    },
    async cancel() {
      downloadAbort?.abort();
      if (state.phase === "ready" && manifest !== null) {
        await removeStaged();
        stagedBundle = null;
        set({ phase: "available", current, release: releaseOf(manifest) });
      }
    },
    async skip() {
      if (manifest === null) return;
      const version = manifest.version;
      downloadAbort?.abort();
      await removeStaged();
      stagedBundle = null;
      await options.writeMemory({ skippedVersion: version });
      log.info("version skipped", { current, target: version });
      manifest = null;
      set({ phase: "idle", current });
    },
    dismiss() {
      if (state.phase !== "error" && state.phase !== "ineligible") return;
      if (state.phase === "error" && state.release !== null && manifest !== null && target !== null) {
        set({ phase: "available", current, release: releaseOf(manifest) });
        return;
      }
      manifest = null;
      set({ phase: "idle", current });
    },
    notesUrl: () => manifest?.notesUrl ?? null,
    ready: () => state.phase === "ready",
    async install() {
      const installTo = target;
      const file = staged;
      if (state.phase !== "ready" || installTo === null || file === null || manifest === null)
        return { relaunch: "none" };
      const installLog = log.child(UPDATE_SCOPE, {
        step: "install",
        current,
        target: manifest.version,
        install: installTo.kind,
      });
      if (installTo.kind === "macBundle" && stagedBundle !== null && file.directory !== null) {
        const script = join(options.tempDirectory, `${options.newId()}-${SWAP_SCRIPT_FILE}`);
        await writeFile(
          script,
          swapScript({
            pid: options.pid,
            bundlePath: installTo.bundlePath,
            stagedPath: stagedBundle,
            stagingPath: file.directory,
            executable: join(MAC_EXECUTABLE_DIRECTORY, basename(options.facts.executablePath)),
            logPath: options.swapLogPath,
            args: options.relaunchArgs,
          }),
          { mode: EXECUTABLE_MODE },
        );
        options.spawnDetached(SH, [script]);
        installLog.info("swap handed to the script", { script });
        staged = null;
        return { relaunch: "external" };
      }
      if (installTo.kind === "nsis") {
        options.spawnDetached(file.path, NSIS_ARGS);
        installLog.info("installer started", { installer: file.path });
        staged = null;
        return { relaunch: "external" };
      }
      if (installTo.kind === "appImage") {
        await rename(file.path, installTo.appImagePath);
        installLog.info("AppImage replaced", { path: installTo.appImagePath });
        staged = null;
        return { relaunch: "self", executable: installTo.appImagePath };
      }
      return { relaunch: "none" };
    },
    async discard() {
      downloadAbort?.abort();
      await removeStaged();
      stagedBundle = null;
    },
    holdsFiles: () => staged !== null || downloadAbort !== null,
  };
}

/** The bytes are not the ones the manifest signed: said as such, never as a network failure. */
export class HashMismatch extends Error {
  override readonly name = "HashMismatch";
}

class StageFailure extends Error {
  override readonly name = "StageFailure";
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}
