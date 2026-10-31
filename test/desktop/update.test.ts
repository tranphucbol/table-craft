import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundlePathFrom, eligibility, type InstallFacts } from "@table-craft/desktop/main/update/eligibility.js";
import {
  compareVersions,
  RELEASE_TRUST,
  UPDATE_PUBLIC_KEY,
  verifyManifest,
  type ManifestTrust,
  type UpdateManifest,
} from "@table-craft/desktop/main/update/manifest.js";
import { drainSwapLog, readUpdateMemory, writeUpdateMemory } from "@table-craft/desktop/main/update/memory.js";
import {
  BETA_MANIFEST_URL,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  RELEASE_MANIFEST_URL,
  updateEndpoint,
  UPDATE_OVERRIDE_ENV,
} from "@table-craft/desktop/main/update/overrides.js";
import { createUpdateSchedule } from "@table-craft/desktop/main/update/schedule.js";
import { shellQuote, swapScript } from "@table-craft/desktop/main/update/swap.js";
import {
  createUpdater,
  loggableUrl,
  removeLeftovers,
  type Fetch,
  type FetchedResponse,
  type UpdateMemory,
  type UpdaterOptions,
} from "@table-craft/desktop/main/update/updater.js";
import type { Logger, LogFields } from "@table-craft/desktop/log/record.js";
import type { UpdateState } from "@table-craft/desktop/preload/bridge.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import { ChannelManifestError, checkBetaManifest } from "../../packages/desktop/scripts/channel-manifest.js";
import {
  installerKey,
  manifestBody,
  ManifestScriptError,
  signBody,
} from "../../packages/desktop/scripts/update-manifest.js";

const MANIFEST_URL = "https://updates.example/releases/latest/download/update-manifest.json";
const SIGNATURE_URL = "https://updates.example/releases/latest/download/update-manifest.json.sig";
const BETA_URL = "https://channels.example/beta/update-manifest.json";
const BETA_SIGNATURE_URL = "https://channels.example/beta/update-manifest.json.sig";
const ASSET_URL = "https://updates.example/releases/download/v0.2.0/TableCraft-0.2.0-arm64.zip";
const NOTES_URL = "https://updates.example/releases/tag/v0.2.0";
const PAYLOAD = Buffer.from("a TableCraft zip, as far as these tests care");

interface KeyPair {
  readonly publicPem: string;
  readonly privatePem: string;
}

function keyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const KEYS = keyPair();
const OTHER_KEYS = keyPair();
const TRUST: ManifestTrust = { publicKeyPem: KEYS.publicPem, allowLoopbackHttp: false };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestDocument(
  overrides: Record<string, unknown> = {},
  payload: Uint8Array = PAYLOAD,
): Record<string, unknown> {
  return {
    schema: 1,
    version: "0.2.0",
    notesUrl: NOTES_URL,
    minimumVersion: null,
    assets: { "darwin-arm64": { url: ASSET_URL, size: payload.byteLength, sha256: sha256(payload) } },
    ...overrides,
  };
}

function signed(document: unknown, keys: KeyPair = KEYS): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(document));
  return { body, signature: signBody(body, keys.privatePem) };
}

interface Logged {
  readonly level: string;
  readonly scope: string;
  readonly msg: string;
  readonly fields: LogFields;
}

function recordingLogger(lines: Logged[], scope = "update", inherited: LogFields = {}): Logger {
  const at =
    (level: string) =>
    (msg: string, fields: LogFields = {}) =>
      lines.push({ level, scope, msg, fields: { ...inherited, ...fields } });
  return {
    error: at("error"),
    warn: at("warn"),
    info: at("info"),
    debug: at("debug"),
    child: (child, fields = {}) => recordingLogger(lines, child, { ...inherited, ...fields }),
  };
}

function response(bytes: Uint8Array, options: { status?: number; failAfter?: number } = {}): FetchedResponse {
  const status = options.status ?? 200;
  const chunkSize = Math.max(1, Math.ceil(bytes.byteLength / 4));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && offset >= options.failAfter) {
        controller.error(new Error("socket hang up"));
        return;
      }
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
  };
}

type Route = () => FetchedResponse | Promise<FetchedResponse>;

function fakeFetch(routes: Record<string, Route>): Fetch & { readonly calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetch = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`getaddrinfo ENOTFOUND for ${url}`);
    return route();
  };
  return Object.assign(fetch, { calls });
}

function release(document: Record<string, unknown> = manifestDocument(), payload: Uint8Array = PAYLOAD, keys = KEYS) {
  const { body, signature } = signed(document, keys);
  return {
    [MANIFEST_URL]: () => response(body),
    [SIGNATURE_URL]: () => response(Buffer.from(signature)),
    [ASSET_URL]: () => response(payload),
  } satisfies Record<string, Route>;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "table-craft-update-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fake installed `TableCraft.app` in `root/Applications`, and the facts main would gather for it. */
async function installedApp(): Promise<InstallFacts> {
  const bundle = join(root, "Applications", "TableCraft.app");
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(bundle, "Contents", "MacOS", "TableCraft"), "#!/bin/sh\n", { mode: 0o755 });
  return {
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    currentVersion: "0.1.0",
    executablePath: join(bundle, "Contents", "MacOS", "TableCraft"),
    appImagePath: undefined,
    writable: () => true,
    bundleModifiable: () => true,
  };
}

/** `ditto -x -k` as the tests see it: unpacks into a new bundle with an executable. */
const unzipBundle: UpdaterOptions["run"] = async (_command, args) => {
  const destination = args[3] ?? "";
  const executable = join(destination, "TableCraft.app", "Contents", "MacOS", "TableCraft");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\necho new\n", { mode: 0o755 });
  return { code: 0, output: "" };
};

interface Harness {
  readonly updater: ReturnType<typeof createUpdater>;
  readonly states: UpdateState[];
  readonly logs: Logged[];
  readonly memory: { value: UpdateMemory };
  readonly spawned: { command: string; args: readonly string[] }[];
  readonly temp: string;
}

async function harness(
  routes: Record<string, Route>,
  overrides: Partial<UpdaterOptions> & { facts?: InstallFacts } = {},
): Promise<Harness> {
  const states: UpdateState[] = [];
  const logs: Logged[] = [];
  const memory = { value: { skippedVersion: null } as UpdateMemory };
  const spawned: { command: string; args: readonly string[] }[] = [];
  const temp = join(root, "temp");
  await mkdir(temp, { recursive: true });
  let id = 0;
  const updater = createUpdater({
    currentVersion: "0.1.0",
    manifestUrls: { stable: MANIFEST_URL, beta: BETA_URL },
    channel: () => "stable",
    trust: TRUST,
    facts: overrides.facts ?? (await installedApp()),
    tempDirectory: temp,
    swapLogPath: join(root, "update-swap.log"),
    pid: 4242,
    relaunchArgs: [],
    fetch: fakeFetch(routes),
    run: unzipBundle,
    spawnDetached: (command, args) => spawned.push({ command, args }),
    readMemory: () => Promise.resolve(memory.value),
    writeMemory: (next) => {
      memory.value = next;
      return Promise.resolve();
    },
    onState: (state) => states.push(state),
    log: recordingLogger(logs),
    newId: () => `id${String((id += 1))}`,
    ...overrides,
  });
  return { updater, states, logs, memory, spawned, temp };
}

async function stagingEntries(): Promise<string[]> {
  return (await readdir(join(root, "Applications"))).filter((name) => name.startsWith(".table-craft-update-"));
}

describe("update manifest", () => {
  it("givenManifestSignedWithTheTrustedKey_whenVerified_thenItsFieldsAreRead", () => {
    const { body, signature } = signed(manifestDocument());

    const verdict = verifyManifest(body, signature, TRUST);

    expect(verdict).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        version: "0.2.0",
        notesUrl: NOTES_URL,
        minimumVersion: null,
      }) as UpdateManifest,
    });
  });

  it("givenOneByteChangedAfterSigning_whenVerified_thenRejectedAsSignature", () => {
    const { body, signature } = signed(manifestDocument());
    const tampered = Buffer.from(body.toString().replace("0.2.0", "9.2.0"));

    expect(verifyManifest(tampered, signature, TRUST)).toMatchObject({ ok: false, reason: "signature" });
  });

  it("givenManifestSignedWithAnotherKey_whenVerified_thenRejectedAsSignature", () => {
    const { body, signature } = signed(manifestDocument(), OTHER_KEYS);

    expect(verifyManifest(body, signature, TRUST)).toMatchObject({ ok: false, reason: "signature" });
  });

  it("givenGarbageSignature_whenVerified_thenRejectedWithoutThrowing", () => {
    const { body } = signed(manifestDocument());

    expect(verifyManifest(body, "not base64 at all ***", TRUST)).toMatchObject({ ok: false, reason: "signature" });
    expect(verifyManifest(body, "", TRUST)).toMatchObject({ ok: false, reason: "signature" });
  });

  it("givenReleaseTrust_whenReadingTheCommittedKey_thenItIsAnEd25519PublicKey", () => {
    expect(RELEASE_TRUST.publicKeyPem).toBe(UPDATE_PUBLIC_KEY);
    expect(UPDATE_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/);
    expect(UPDATE_PUBLIC_KEY).not.toMatch(/PRIVATE/);
  });

  it("givenManifestWithoutChannel_whenVerified_thenStable", () => {
    const { body, signature } = signed(manifestDocument());

    expect(verifyManifest(body, signature, TRUST)).toMatchObject({ ok: true, manifest: { channel: "stable" } });
  });

  it("givenBetaChannel_whenVerified_thenBeta", () => {
    const { body, signature } = signed(manifestDocument({ version: "0.2.0-beta.1", channel: "beta" }));

    expect(verifyManifest(body, signature, TRUST)).toMatchObject({ ok: true, manifest: { channel: "beta" } });
  });

  it("givenAnotherSchema_whenVerified_thenRejectedAsSchema", () => {
    const { body, signature } = signed(manifestDocument({ schema: 2 }));

    expect(verifyManifest(body, signature, TRUST)).toMatchObject({ ok: false, reason: "schema" });
  });

  it.each([
    ["a version that is not semver", { version: "latest" }],
    ["an unknown channel", { channel: "nightly" }],
    ["an http notes URL", { notesUrl: "http://example.com/notes" }],
    [
      "an http asset",
      { assets: { "darwin-arm64": { url: "http://updates.example/a.zip", size: 1, sha256: "a".repeat(64) } } },
    ],
    ["an uppercase hash", { assets: { "darwin-arm64": { url: ASSET_URL, size: 1, sha256: "A".repeat(64) } } }],
    ["a zero size", { assets: { "darwin-arm64": { url: ASSET_URL, size: 0, sha256: "a".repeat(64) } } }],
    [
      "credentials in the asset URL",
      { assets: { "darwin-arm64": { url: "https://u:p@x.example/a", size: 1, sha256: "a".repeat(64) } } },
    ],
  ])("givenManifestWith %s_whenVerified_thenRejectedAsMalformed", (_what, overrides) => {
    const { body, signature } = signed(manifestDocument(overrides));

    expect(verifyManifest(body, signature, TRUST)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("givenLoopbackHttpAsset_whenVerifiedWithTestTrust_thenAcceptedAndOtherwiseRejected", () => {
    const local = {
      "darwin-arm64": { url: "http://127.0.0.1:8123/TableCraft-0.2.0-arm64.zip", size: 1, sha256: "a".repeat(64) },
    };
    const { body, signature } = signed(manifestDocument({ assets: local }));

    expect(verifyManifest(body, signature, { ...TRUST, allowLoopbackHttp: true }).ok).toBe(true);
    expect(verifyManifest(body, signature, TRUST)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it.each([
    ["0.2.0", "0.1.9", 1],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["0.0.0-dev.8379c80", "0.1.0", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
  ])("givenVersions %s and %s_whenCompared_thenOrder %d", (left, right, order) => {
    expect(compareVersions(left, right)).toBe(order);
  });
});

describe("update eligibility", () => {
  const manifest = (overrides: Partial<UpdateManifest> = {}): UpdateManifest => ({
    schema: 1,
    version: "0.2.0",
    channel: "stable",
    notesUrl: NOTES_URL,
    minimumVersion: null,
    assets: { "darwin-arm64": { url: ASSET_URL, size: 1, sha256: "a".repeat(64) } },
    ...overrides,
  });
  const facts = (overrides: Partial<InstallFacts> = {}): InstallFacts => ({
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    currentVersion: "0.1.0",
    executablePath: "/Applications/TableCraft.app/Contents/MacOS/TableCraft",
    appImagePath: undefined,
    writable: () => true,
    bundleModifiable: () => true,
    ...overrides,
  });

  it("givenAppInApplications_whenChecked_thenTheBundleIsTheTarget", () => {
    expect(eligibility(facts(), manifest(), "darwin-arm64")).toEqual({
      eligible: true,
      target: { kind: "macBundle", bundlePath: "/Applications/TableCraft.app" },
    });
  });

  it.each([
    ["an unpackaged run", { packaged: false }, "darwin-arm64", "unpackaged"],
    ["an architecture the release lacks", { arch: "x64" }, "darwin-x64", "noAsset"],
    [
      "a translocated bundle",
      { executablePath: "/private/var/folders/x/AppTranslocation/ABC/d/TableCraft.app/Contents/MacOS/TableCraft" },
      "darwin-arm64",
      "translocated",
    ],
    [
      "a mounted DMG",
      { executablePath: "/Volumes/TableCraft/TableCraft.app/Contents/MacOS/TableCraft" },
      "darwin-arm64",
      "readOnlyVolume",
    ],
    ["a read-only parent", { writable: () => false }, "darwin-arm64", "notWritable"],
    ["a bundle App Management protects", { bundleModifiable: () => false }, "darwin-arm64", "appManagement"],
    ["an executable outside a bundle", { executablePath: "/usr/local/bin/table-craft" }, "darwin-arm64", "unpackaged"],
    ["a Linux build that is not an AppImage", { platform: "linux" as const, arch: "x64" }, "linux-x64", "noAsset"],
  ])("givenInstallFrom %s_whenChecked_thenIneligible", (_what, overrides, key, reason) => {
    const offered = manifest({
      assets: {
        "darwin-arm64": { url: ASSET_URL, size: 1, sha256: "a".repeat(64) },
      },
    });

    expect(eligibility(facts(overrides), offered, key)).toEqual({ eligible: false, reason });
  });

  it("givenVersionBelowTheMinimum_whenChecked_thenTooOld", () => {
    expect(eligibility(facts(), manifest({ minimumVersion: "0.1.5" }), "darwin-arm64")).toEqual({
      eligible: false,
      reason: "tooOld",
    });
  });

  it("givenLinuxAppImage_whenChecked_thenTheImageIsTheTarget", () => {
    const linux = manifest({ assets: { "linux-x64": { url: ASSET_URL, size: 1, sha256: "a".repeat(64) } } });

    expect(
      eligibility(
        facts({ platform: "linux", arch: "x64", appImagePath: "/home/u/TableCraft.AppImage" }),
        linux,
        "linux-x64",
      ),
    ).toEqual({
      eligible: true,
      target: { kind: "appImage", appImagePath: "/home/u/TableCraft.AppImage" },
    });
    expect(eligibility(facts({ platform: "linux", arch: "x64" }), linux, "linux-x64")).toEqual({
      eligible: false,
      reason: "notAppImage",
    });
  });

  it("givenWindows_whenChecked_thenTheInstallerIsTheTarget", () => {
    const windows = manifest({ assets: { "win32-x64": { url: ASSET_URL, size: 1, sha256: "a".repeat(64) } } });

    expect(
      eligibility(
        facts({ platform: "win32", arch: "x64", executablePath: "C:\\TableCraft.exe" }),
        windows,
        "win32-x64",
      ),
    ).toEqual({
      eligible: true,
      target: { kind: "nsis" },
    });
  });

  it("givenExecutablePaths_whenBundleSought_thenOnlyARealBundleIsFound", () => {
    expect(bundlePathFrom("/Applications/TableCraft.app/Contents/MacOS/TableCraft")).toBe(
      "/Applications/TableCraft.app",
    );
    expect(bundlePathFrom("/Applications/TableCraft.app/Contents/Frameworks/TableCraft")).toBeNull();
    expect(bundlePathFrom("/opt/table-craft/table-craft")).toBeNull();
  });
});

describe("updater", () => {
  it("givenNoNewerVersion_whenCheckedManually_thenIdleAndLoggedUpToDate", async () => {
    const { updater, logs } = await harness(release(manifestDocument({ version: "0.1.0" })));

    const state = await updater.check("manual");

    expect(state).toEqual({ phase: "idle", current: "0.1.0" });
    expect(logs.map((line) => line.msg)).toContain("up to date");
  });

  it("givenNewerVersion_whenChecked_thenAvailableWithItsVersionAndSize", async () => {
    const { updater, states } = await harness(release());

    await updater.check("automatic");

    expect(states.map((state) => state.phase)).toEqual(["checking", "available"]);
    expect(updater.state()).toEqual({
      phase: "available",
      current: "0.1.0",
      release: { version: "0.2.0", size: PAYLOAD.byteLength },
    });
    expect(updater.notesUrl()).toBe(NOTES_URL);
  });

  it("givenTamperedSignature_whenChecked_thenErrorNotRetryableNothingDownloadedAndLoggedAtError", async () => {
    const routes = release();
    const { body } = signed(manifestDocument({ version: "0.3.0" }), OTHER_KEYS);
    routes[MANIFEST_URL] = () => response(body);
    const fetch = fakeFetch(routes);
    const { updater, logs } = await harness(routes, { fetch });

    const state = await updater.check("automatic");
    await updater.download();

    expect(state).toMatchObject({ phase: "error", release: null, retryable: false });
    expect(fetch.calls).not.toContain(ASSET_URL);
    expect(logs.filter((line) => line.level === "error").map((line) => line.fields.reason)).toEqual(["signature"]);
  });

  it("givenManifestOfALaterSchema_whenChecked_thenAutomaticStaysQuietAndManualReportsIt", async () => {
    const routes = release();
    const { body, signature } = signed(manifestDocument({ schema: 2 }));
    routes[MANIFEST_URL] = () => response(body);
    routes[SIGNATURE_URL] = () => response(Buffer.from(signature));
    const { updater, logs } = await harness(routes);

    expect(await updater.check("automatic")).toEqual({ phase: "idle", current: "0.1.0" });
    expect(await updater.check("manual")).toMatchObject({ phase: "error", retryable: false });
    expect(logs.filter((line) => line.level === "error")).toEqual([]);
  });

  it("givenNetworkDown_whenCheckedAutomatically_thenIdleAndLoggedAtWarn", async () => {
    const { updater, logs } = await harness({});

    expect(await updater.check("automatic")).toEqual({ phase: "idle", current: "0.1.0" });
    expect(logs.filter((line) => line.level === "warn").map((line) => line.msg)).toEqual(["update check failed"]);
  });

  it("givenNetworkDown_whenCheckedManually_thenRetryableErrorThatRetryChecksAgain", async () => {
    const routes: Record<string, Route> = {};
    const fetch = fakeFetch(routes);
    const { updater } = await harness(routes, { fetch });

    expect(await updater.check("manual")).toMatchObject({ phase: "error", release: null, retryable: true });
    Object.assign(routes, release());
    await updater.download();

    expect(updater.state().phase).toBe("available");
  });

  it("givenSkippedVersion_whenCheckedAutomatically_thenIdleButAManualCheckStillOffersIt", async () => {
    const { updater, memory } = await harness(release());
    await updater.check("automatic");

    await updater.skip();

    expect(memory.value).toEqual({ skippedVersion: "0.2.0" });
    expect(await updater.check("automatic")).toEqual({ phase: "idle", current: "0.1.0" });
    expect((await updater.check("manual")).phase).toBe("available");
  });

  it("givenTheLastSwapWasDenied_whenChecked_thenTheFailureIsExplainedOnceAndRetryable", async () => {
    const { updater } = await harness(release(), {
      lastSwapFailure: { reason: "the installed app could not be moved aside; nothing was replaced", denied: true },
    });

    const first = await updater.check("automatic");
    updater.dismiss();
    const second = await updater.check("automatic");

    expect(first).toMatchObject({ phase: "error", release: { version: "0.2.0" }, retryable: true });
    expect(first.phase === "error" ? first.message : "").toMatch(/was not installed.*App Management/);
    expect(second.phase).toBe("available");
  });

  it("givenTheLastSwapFailedOtherwise_whenChecked_thenItsReasonIsShown", async () => {
    const { updater } = await harness(release(), {
      lastSwapFailure: { reason: "the new app has no executable; the installed app was restored", denied: false },
    });

    const state = await updater.check("manual");
    await updater.download();

    expect(state.phase === "error" ? state.message : "").toMatch(/no executable; the installed app was restored/);
    expect(updater.state().phase).toBe("ready");
  });

  it("givenBundleMacOSWillNotLetChange_whenChecked_thenIneligibleWithTheAppManagementHint", async () => {
    const facts = { ...(await installedApp()), bundleModifiable: () => false };
    const fetch = fakeFetch(release());
    const { updater } = await harness(release(), { facts, fetch });

    const state = await updater.check("automatic");

    expect(state).toMatchObject({ phase: "ineligible", release: { version: "0.2.0" } });
    expect(state.phase === "ineligible" ? state.message : "").toMatch(/App Management/);
    expect(fetch.calls).not.toContain(ASSET_URL);
  });

  it("givenIneligibleInstall_whenChecked_thenIneligibleWithAMessageAndNoDownload", async () => {
    const facts = {
      ...(await installedApp()),
      executablePath: "/Volumes/TableCraft/TableCraft.app/Contents/MacOS/TableCraft",
    };
    const fetch = fakeFetch(release());
    const { updater } = await harness(release(), { facts, fetch });

    const state = await updater.check("manual");
    await updater.download();

    expect(state).toMatchObject({ phase: "ineligible", release: { version: "0.2.0" } });
    expect(state.phase === "ineligible" ? state.message : "").toMatch(/disk image/);
    expect(fetch.calls).not.toContain(ASSET_URL);
  });

  it("givenUpdateAvailable_whenAnAutomaticCheckRuns_thenCheckingIsNeverPushed", async () => {
    const { updater, states } = await harness(release());
    await updater.check("automatic");
    states.length = 0;

    await updater.check("automatic");

    expect(states.map((state) => state.phase)).toEqual(["available"]);
  });

  it("givenUpdateFailed_whenAnAutomaticCheckIsUnreachable_thenTheErrorStaysWithoutAFlicker", async () => {
    const { updater, states } = await harness({});
    await updater.check("manual");
    states.length = 0;

    const state = await updater.check("automatic");

    expect(state).toMatchObject({ phase: "error", retryable: true });
    expect(states.map((each) => each.phase)).toEqual(["error"]);
  });

  it("givenUpdateAvailable_whenAManualCheckRuns_thenCheckingIsPushedFirst", async () => {
    const { updater, states } = await harness(release());
    await updater.check("automatic");
    states.length = 0;

    await updater.check("manual");

    expect(states.map((state) => state.phase)).toEqual(["checking", "available"]);
  });

  it("givenTwoChecksAtOnce_whenBothRun_thenTheManifestIsFetchedOnce", async () => {
    const fetch = fakeFetch(release());
    const { updater } = await harness(release(), { fetch });

    await Promise.all([updater.check("automatic"), updater.check("manual")]);

    expect(fetch.calls.filter((url) => url === MANIFEST_URL)).toHaveLength(1);
  });

  function withBeta(routes: Record<string, Route>, version: string, keys = KEYS): Record<string, Route> {
    const { body, signature } = signed(manifestDocument({ version, channel: "beta" }), keys);
    return {
      ...routes,
      [BETA_URL]: () => response(body),
      [BETA_SIGNATURE_URL]: () => response(Buffer.from(signature)),
    };
  }

  const onBeta = { channel: () => "beta" as const };

  it("givenBetaChannel_whenTheBetaIsNewer_thenTheBetaIsOffered", async () => {
    const { updater } = await harness(withBeta(release(), "0.3.0-beta.1"), onBeta);

    expect(await updater.check("manual")).toMatchObject({ phase: "available", release: { version: "0.3.0-beta.1" } });
  });

  it("givenBetaChannel_whenTheStableReleaseIsNewer_thenTheStableReleaseIsOffered", async () => {
    const stable = release(manifestDocument({ version: "0.3.0" }));
    const { updater } = await harness(withBeta(stable, "0.3.0-beta.2"), onBeta);

    expect(await updater.check("manual")).toMatchObject({ phase: "available", release: { version: "0.3.0" } });
  });

  it("givenStableChannel_whenChecked_thenTheBetaManifestIsNotFetched", async () => {
    const routes = withBeta(release(), "0.3.0-beta.1");
    const fetch = fakeFetch(routes);
    const { updater } = await harness(routes, { fetch });

    expect(await updater.check("manual")).toMatchObject({ release: { version: "0.2.0" } });
    expect(fetch.calls).not.toContain(BETA_URL);
  });

  it("givenBetaChannel_whenNoBetaIsPublishedYet_thenTheStableReleaseIsOfferedAndAWarningLogged", async () => {
    const routes = { ...release(), [BETA_URL]: () => response(Buffer.from("Not Found"), { status: 404 }) };
    const { updater, logs } = await harness(routes, onBeta);

    expect(await updater.check("manual")).toMatchObject({ phase: "available", release: { version: "0.2.0" } });
    expect(logs.filter((line) => line.level === "warn")).toMatchObject([
      { msg: "update check failed", fields: { url: BETA_URL } },
    ]);
  });

  it("givenBetaChannel_whenTheStableManifestIsUnreachable_thenTheBetaIsStillOffered", async () => {
    const routes = withBeta({ [ASSET_URL]: () => response(PAYLOAD) }, "0.3.0-beta.1");
    const { updater } = await harness(routes, onBeta);

    expect(await updater.check("manual")).toMatchObject({ phase: "available", release: { version: "0.3.0-beta.1" } });
  });

  it("givenBetaChannel_whenBothManifestsAreUnreachable_thenARetryableError", async () => {
    const { updater } = await harness({}, onBeta);

    expect(await updater.check("manual")).toMatchObject({ phase: "error", release: null, retryable: true });
  });

  it("givenBetaChannel_whenTheBetaSignatureIsBad_thenTheStableReleaseIsOfferedAndTheRejectionLoggedAtError", async () => {
    const { updater, logs } = await harness(withBeta(release(), "0.3.0-beta.1", OTHER_KEYS), onBeta);

    expect(await updater.check("automatic")).toMatchObject({ phase: "available", release: { version: "0.2.0" } });
    expect(logs.filter((line) => line.level === "error")).toMatchObject([
      { msg: "update manifest rejected", fields: { url: BETA_URL, reason: "signature" } },
    ]);
  });

  it("givenStableChannel_whenTheStableUrlServesABeta_thenIdleAndTheMismatchLogged", async () => {
    const { updater, logs } = await harness(release(manifestDocument({ version: "0.3.0-beta.1", channel: "beta" })));

    expect(await updater.check("manual")).toEqual({ phase: "idle", current: "0.1.0" });
    expect(logs.map((line) => line.msg)).toContain("update manifest is for another channel");
  });

  it("givenABetaInstallOnTheStableChannel_whenOnlyAnOlderStableExists_thenNoDowngrade", async () => {
    const { updater } = await harness(release(), { currentVersion: "0.3.0-beta.1" });

    expect(await updater.check("manual")).toEqual({ phase: "idle", current: "0.3.0-beta.1" });
  });

  it("givenTheChannelChanges_whenCheckedAgain_thenTheNextCheckUsesIt", async () => {
    let channel: ReleaseChannel = "stable";
    const { updater } = await harness(withBeta(release(), "0.3.0-beta.1"), { channel: () => channel });
    expect(await updater.check("manual")).toMatchObject({ release: { version: "0.2.0" } });

    channel = "beta";

    expect(await updater.check("manual")).toMatchObject({ release: { version: "0.3.0-beta.1" } });
  });

  it("givenAvailableUpdate_whenDownloaded_thenStagedBesideTheBundleAndReady", async () => {
    const { updater, states, logs, temp } = await harness(release());
    await updater.check("manual");

    await updater.download();

    expect(updater.state()).toEqual({
      phase: "ready",
      current: "0.1.0",
      release: { version: "0.2.0", size: PAYLOAD.byteLength },
    });
    expect(states.some((state) => state.phase === "downloading")).toBe(true);
    expect(await stagingEntries()).toEqual([expect.stringMatching(/^\.table-craft-update-id\d$/) as string]);
    expect(await readdir(temp)).toEqual([]);
    const milestones = logs.filter((line) => line.msg === "download progress").map((line) => line.fields.percent);
    expect(milestones).toEqual([25, 50, 75]);
    expect(logs.find((line) => line.msg === "download started")?.fields).toMatchObject({
      current: "0.1.0",
      target: "0.2.0",
    });
  });

  it("givenCorruptedDownload_whenDownloaded_thenErrorNamesTheHashAndNothingIsKept", async () => {
    const corrupt = Buffer.from(PAYLOAD);
    corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
    const routes = release();
    routes[ASSET_URL] = () => response(corrupt);
    const { updater, logs, temp } = await harness(routes);
    await updater.check("manual");

    await updater.download();

    const state = updater.state();
    expect(state).toMatchObject({ phase: "error", retryable: true, release: { version: "0.2.0" } });
    expect(state.phase === "error" ? state.message : "").toMatch(
      /does not match the signed release: SHA-256 [0-9a-f]{64}/,
    );
    expect(state.phase === "error" ? state.message : "").not.toMatch(/could not be fetched|interrupted/);
    expect(await readdir(temp)).toEqual([]);
    expect(await stagingEntries()).toEqual([]);
    expect(logs.filter((line) => line.level === "error").map((line) => line.msg)).toEqual([
      "downloaded update does not match the manifest",
    ]);
  });

  it("givenDownloadLongerThanTheManifestSays_whenDownloaded_thenStoppedAsAMismatch", async () => {
    const routes = release(
      manifestDocument({ assets: { "darwin-arm64": { url: ASSET_URL, size: 4, sha256: sha256(PAYLOAD) } } }),
    );
    const { updater } = await harness(routes);
    await updater.check("manual");

    await updater.download();

    expect(updater.state()).toMatchObject({
      phase: "error",
      message: expect.stringMatching(/more than the 4 bytes/) as string,
    });
  });

  it("givenNetworkCutMidDownload_whenDownloaded_thenRetryableErrorTempRemovedAndRetrySucceeds", async () => {
    const routes = release();
    let attempts = 0;
    routes[ASSET_URL] = () => {
      attempts += 1;
      return attempts === 1 ? response(PAYLOAD, { failAfter: 12 }) : response(PAYLOAD);
    };
    const { updater, temp, logs } = await harness(routes);
    await updater.check("manual");

    await updater.download();

    expect(updater.state()).toMatchObject({
      phase: "error",
      retryable: true,
      message: expect.stringMatching(/interrupted \(socket hang up\)/) as string,
    });
    expect(await readdir(temp)).toEqual([]);
    expect(logs.filter((line) => line.level === "warn").map((line) => line.msg)).toEqual(["download failed"]);

    await updater.download();

    expect(updater.state().phase).toBe("ready");
  });

  it("givenDownloadInFlight_whenCancelled_thenAvailableAgainAndNothingKept", async () => {
    const routes = release();
    let release_: (() => void) | null = null;
    routes[ASSET_URL] = () => ({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new Error("unused")),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PAYLOAD.subarray(0, 4));
          release_ = () => controller.error(new DOMException("aborted", "AbortError"));
        },
      }),
    });
    const { updater, temp } = await harness(routes);
    await updater.check("manual");

    const downloading = updater.download();
    await vi.waitFor(() => expect(updater.state().phase).toBe("downloading"));
    await updater.cancel();
    (release_ as (() => void) | null)?.();
    await downloading;

    expect(updater.state().phase).toBe("available");
    expect(await readdir(temp)).toEqual([]);
  });

  it("givenArchiveDittoCannotUnpack_whenDownloaded_thenUnpackableErrorNotAFetchError", async () => {
    const { updater } = await harness(release(), { run: () => Promise.resolve({ code: 1, output: "ditto: bad zip" }) });
    await updater.check("manual");

    await updater.download();

    expect(updater.state()).toMatchObject({
      phase: "error",
      message: expect.stringMatching(/could not be unpacked/) as string,
    });
    expect(await stagingEntries()).toEqual([]);
  });

  it("givenArchiveWithoutAnApp_whenDownloaded_thenUnpackableError", async () => {
    const { updater } = await harness(release(), { run: () => Promise.resolve({ code: 0, output: "" }) });
    await updater.check("manual");

    await updater.download();

    expect(updater.state()).toMatchObject({
      phase: "error",
      message: expect.stringMatching(/could not be unpacked/) as string,
    });
  });

  it("givenReadyUpdate_whenInstalled_thenTheSwapScriptIsHandedOverDetached", async () => {
    const { updater, spawned } = await harness(release());
    await updater.check("manual");
    await updater.download();

    const outcome = await updater.install();

    expect(outcome).toEqual({ relaunch: "external" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe("/bin/sh");
    const script = await readFile(spawned[0]?.args[0] ?? "", "utf8");
    expect(script).toContain("PID=4242");
    expect(script).toContain(shellQuote(join(root, "Applications", "TableCraft.app")));
  });

  it("givenNothingReady_whenInstalled_thenNothingIsSpawned", async () => {
    const { updater, spawned } = await harness(release());
    await updater.check("manual");

    expect(await updater.install()).toEqual({ relaunch: "none" });
    expect(spawned).toEqual([]);
  });

  it("givenReadyUpdate_whenDiscardedOnQuit_thenStagingIsGone", async () => {
    const { updater } = await harness(release());
    await updater.check("manual");
    await updater.download();
    expect(updater.holdsFiles()).toBe(true);

    await updater.discard();

    expect(await stagingEntries()).toEqual([]);
    expect(updater.holdsFiles()).toBe(false);
  });

  it("givenWindowsInstall_whenReadyAndInstalled_thenTheInstallerRunsSilentlyAndDetached", async () => {
    const windowsAsset = "https://updates.example/TableCraft-0.2.0-x64.exe";
    const document = manifestDocument({
      assets: { "win32-x64": { url: windowsAsset, size: PAYLOAD.byteLength, sha256: sha256(PAYLOAD) } },
    });
    const routes = { ...release(document), [windowsAsset]: () => response(PAYLOAD) };
    const facts: InstallFacts = {
      ...(await installedApp()),
      platform: "win32",
      arch: "x64",
      executablePath: "C:\\TableCraft\\TableCraft.exe",
    };
    const { updater, spawned } = await harness(routes, { facts });
    await updater.check("manual");
    await updater.download();

    expect(await updater.install()).toEqual({ relaunch: "external" });
    expect(spawned[0]?.args).toEqual(["/S", "--updated", "--force-run"]);
    expect(spawned[0]?.command.endsWith(".exe")).toBe(true);
  });

  it("givenAppImage_whenReadyAndInstalled_thenTheImageIsReplacedAndRelaunchedItself", async () => {
    const linuxAsset = "https://updates.example/TableCraft-0.2.0-x64.AppImage";
    const document = manifestDocument({
      assets: { "linux-x64": { url: linuxAsset, size: PAYLOAD.byteLength, sha256: sha256(PAYLOAD) } },
    });
    const image = join(root, "apps", "TableCraft.AppImage");
    await mkdir(dirname(image), { recursive: true });
    await writeFile(image, "old image");
    const facts: InstallFacts = {
      ...(await installedApp()),
      platform: "linux",
      arch: "x64",
      executablePath: "/tmp/.mount/table-craft",
      appImagePath: image,
    };
    const { updater } = await harness({ ...release(document), [linuxAsset]: () => response(PAYLOAD) }, { facts });
    await updater.check("manual");
    await updater.download();

    expect(await updater.install()).toEqual({ relaunch: "self", executable: image });
    expect(await readFile(image)).toEqual(PAYLOAD);
    expect(await readdir(dirname(image))).toEqual(["TableCraft.AppImage"]);
  });

  it("givenLeftoverStagingFromACrash_whenRemoved_thenOnlyUpdaterDirectoriesGo", async () => {
    const facts = await installedApp();
    const bundlePath = bundlePathFrom(facts.executablePath) ?? "";
    await mkdir(join(dirname(bundlePath), ".table-craft-update-old"), { recursive: true });
    await mkdir(join(dirname(bundlePath), "Other.app"), { recursive: true });

    await removeLeftovers({ kind: "macBundle", bundlePath }, recordingLogger([]));

    expect((await readdir(dirname(bundlePath))).sort()).toEqual(["Other.app", "TableCraft.app"]);
  });

  it("givenSignedAssetUrl_whenLogged_thenItsQueryIsStripped", () => {
    expect(loggableUrl("https://objects.example/a.zip?X-Amz-Signature=secret&token=t")).toBe(
      "https://objects.example/a.zip",
    );
  });
});

/** The relaunched stand-in runs detached; under a loaded test run it can take a while to start. */
const RELAUNCH_WAIT = { timeout: 10_000 };
const SHELL_AVAILABLE = process.platform !== "win32" && existsSync("/bin/sh");

describe.runIf(SHELL_AVAILABLE)("swap script", () => {
  async function swapFixture(options: { executableInNew?: boolean; args?: readonly string[] } = {}) {
    const applications = join(root, "Apps with 'quotes' and spaces");
    const bundle = join(applications, "TableCraft.app");
    const staging = join(applications, ".table-craft-update-x");
    const staged = join(staging, "TableCraft.app");
    const relaunched = join(root, "relaunched");
    for (const [app, label] of [
      [bundle, "old"],
      [staged, "new"],
    ] as const) {
      await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(app, "Contents", "version"), label);
      if (label === "old" || options.executableInNew !== false) {
        const executable = join(app, "Contents", "MacOS", "TableCraft");
        await writeFile(executable, `#!/bin/sh\necho ${label} "$@" > ${shellQuote(relaunched)}\n`);
        await chmod(executable, 0o755);
      }
    }
    const logPath = join(root, "update-swap.log");
    // A process that has already exited, so the wait ends at once.
    const gone = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
    const script = swapScript({
      pid: Number(gone.stdout.trim()),
      bundlePath: bundle,
      stagedPath: staged,
      stagingPath: staging,
      executable: "Contents/MacOS/TableCraft",
      logPath,
      args: options.args ?? [],
    });
    return { bundle, staging, applications, relaunched, logPath, run: () => spawnSync("/bin/sh", ["-c", script]) };
  }

  it("givenStagedBundle_whenTheScriptRuns_thenItIsInstalledRelaunchedAndStagingIsGone", async () => {
    const fixture = await swapFixture();

    const result = fixture.run();

    expect(result.status).toBe(0);
    expect(await readFile(join(fixture.bundle, "Contents", "version"), "utf8")).toBe("new");
    expect(await readdir(fixture.applications)).toEqual(["TableCraft.app"]);
    await vi.waitFor(async () => expect(await readFile(fixture.relaunched, "utf8")).toBe("new\n"), RELAUNCH_WAIT);
    expect(await readFile(fixture.logPath, "utf8")).toMatch(/replaced; relaunching/);
  });

  it("givenARunStartedWithFlags_whenTheScriptRelaunches_thenTheNewAppGetsThemToo", async () => {
    const fixture = await swapFixture({ args: ["--use-mock-keychain", "it's $HOME"] });

    expect(fixture.run().status).toBe(0);

    await vi.waitFor(
      async () => expect(await readFile(fixture.relaunched, "utf8")).toBe("new --use-mock-keychain it's $HOME\n"),
      RELAUNCH_WAIT,
    );
  });

  it("givenNewBundleWithoutExecutable_whenTheScriptRuns_thenTheOldOneIsRestoredAndRelaunched", async () => {
    const fixture = await swapFixture({ executableInNew: false });

    const result = fixture.run();

    expect(result.status).toBe(1);
    expect(await readFile(join(fixture.bundle, "Contents", "version"), "utf8")).toBe("old");
    expect(await readdir(fixture.applications)).toEqual(["TableCraft.app"]);
    await vi.waitFor(async () => expect(await readFile(fixture.relaunched, "utf8")).toBe("old\n"), RELAUNCH_WAIT);
    expect(await readFile(fixture.logPath, "utf8")).toMatch(/installed app was restored/);
  });

  it("givenAppThatNeverQuits_whenTheScriptGivesUp_thenNothingIsReplaced", () => {
    const script = swapScript({
      pid: process.pid,
      bundlePath: "/nonexistent/TableCraft.app",
      stagedPath: "/nonexistent/staged",
      stagingPath: "/nonexistent/staging",
      executable: "Contents/MacOS/TableCraft",
      logPath: "/dev/null",
      args: [],
    });

    expect(script).toMatch(/did not quit; nothing was replaced/);
    expect(script.indexOf("did not quit")).toBeLessThan(script.indexOf('mv "$TARGET" "$BACKUP"'));
  });

  it("givenPathWithQuotes_whenQuoted_thenTheShellReadsItBack", () => {
    const path = '/tmp/it\'s a "path" $HOME `x`';

    expect(spawnSync("/bin/sh", ["-c", `printf %s ${shellQuote(path)}`], { encoding: "utf8" }).stdout).toBe(path);
  });
});

describe("update endpoint", () => {
  const readKey = (path: string) => `key from ${path}`;

  it("givenReleaseBuild_whenOverridesAreSet_thenTheyAreIgnored", () => {
    const env = {
      [UPDATE_OVERRIDE_ENV.manifestUrl]: "http://127.0.0.1:1/m.json",
      [UPDATE_OVERRIDE_ENV.publicKey]: "/k.pem",
    };

    expect(updateEndpoint(env, false, readKey)).toEqual({
      manifestUrl: RELEASE_MANIFEST_URL,
      betaManifestUrl: BETA_MANIFEST_URL,
      trust: RELEASE_TRUST,
      firstCheckMs: FIRST_CHECK_DELAY_MS,
      overridden: false,
    });
  });

  it("givenTestBuild_whenOverridesAreSet_thenTheLocalReleaseAndKeyAreUsed", () => {
    const env = {
      [UPDATE_OVERRIDE_ENV.manifestUrl]: "http://127.0.0.1:1/m.json",
      [UPDATE_OVERRIDE_ENV.publicKey]: "/k.pem",
      [UPDATE_OVERRIDE_ENV.firstCheckMs]: "500",
    };

    expect(updateEndpoint(env, true, readKey)).toEqual({
      manifestUrl: "http://127.0.0.1:1/m.json",
      betaManifestUrl: BETA_MANIFEST_URL,
      trust: { publicKeyPem: "key from /k.pem", allowLoopbackHttp: true },
      firstCheckMs: 500,
      overridden: true,
    });
  });

  it("givenTestBuild_whenOnlyTheBetaManifestIsOverridden_thenLoopbackAllowedAndStableKept", () => {
    const env = { [UPDATE_OVERRIDE_ENV.betaManifestUrl]: "http://127.0.0.1:1/beta/m.json" };

    expect(updateEndpoint(env, true, readKey)).toMatchObject({
      manifestUrl: RELEASE_MANIFEST_URL,
      betaManifestUrl: "http://127.0.0.1:1/beta/m.json",
      trust: { allowLoopbackHttp: true },
      overridden: true,
    });
  });

  it("givenTestBuildWithoutOverrides_whenRead_thenTheReleaseEndpoint", () => {
    expect(updateEndpoint({}, true, readKey).overridden).toBe(false);
  });
});

describe("update schedule", () => {
  function timers() {
    const pending: { run: () => void; ms: number; repeat: boolean; cleared: boolean }[] = [];
    const add = (repeat: boolean) => (run: () => void, ms: number) => {
      const timer = { run, ms, repeat, cleared: false };
      pending.push(timer);
      return timer;
    };
    const clear = (timer: unknown) => {
      (timer as { cleared: boolean }).cleared = true;
    };
    return {
      pending,
      timers: { setTimeout: add(false), setInterval: add(true), clearTimeout: clear, clearInterval: clear },
    };
  }

  it("givenReleaseBuild_whenTheIntervalIsRead_thenChecksRepeatEveryTwoHours", () => {
    expect(CHECK_INTERVAL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("givenEnabled_whenStarted_thenOneCheckAfterTheDelayThenEveryInterval", () => {
    const check = vi.fn();
    const clock = timers();
    const schedule = createUpdateSchedule({
      check,
      enabled: true,
      firstDelayMs: 10,
      intervalMs: 1000,
      timers: clock.timers,
    });

    schedule.start();
    schedule.start();

    expect(clock.pending.map(({ ms, repeat }) => ({ ms, repeat }))).toEqual([
      { ms: 10, repeat: false },
      { ms: 1000, repeat: true },
    ]);
    clock.pending[0]?.run();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("givenDisabled_whenStartedThenEnabled_thenChecksBeginOnlyWhenEnabled", () => {
    const clock = timers();
    const schedule = createUpdateSchedule({
      check: vi.fn(),
      enabled: false,
      firstDelayMs: 10,
      intervalMs: 1000,
      timers: clock.timers,
    });

    schedule.start();
    expect(clock.pending).toEqual([]);
    schedule.setEnabled(true);
    expect(clock.pending.filter((timer) => !timer.cleared)).toHaveLength(2);
    schedule.setEnabled(false);
    expect(clock.pending.filter((timer) => !timer.cleared)).toEqual([]);
  });
});

describe("update memory", () => {
  it("givenStateFile_whenReadBack_thenTheSkippedVersionSurvivesAndJunkIsIgnored", () => {
    expect(readUpdateMemory(writeUpdateMemory({ skippedVersion: "0.2.0" }))).toEqual({ skippedVersion: "0.2.0" });
    expect(readUpdateMemory("{")).toEqual({ skippedVersion: null });
    expect(readUpdateMemory(JSON.stringify({ skippedVersion: "; rm -rf" }))).toEqual({ skippedVersion: null });
    expect(readUpdateMemory(null)).toEqual({ skippedVersion: null });
  });

  it("givenSwapLog_whenDrained_thenEachLineIsLoggedOnceAndFailuresWarn", async () => {
    const lines: Logged[] = [];
    const files = new Map([
      [
        "/p/update-swap.log",
        "t waiting for TableCraft\nt the new app has no executable; the installed app was restored\n",
      ],
    ]);
    const store = {
      readText: (path: string) => Promise.resolve(files.get(path) ?? null),
      writeText: () => Promise.resolve(),
      remove: (path: string) => {
        files.delete(path);
        return Promise.resolve();
      },
    };

    const first = await drainSwapLog("/p/update-swap.log", store, recordingLogger(lines));
    const second = await drainSwapLog("/p/update-swap.log", store, recordingLogger(lines));

    expect(lines.map((line) => line.level)).toEqual(["info", "warn"]);
    expect(first).toMatchObject({ denied: false });
    expect(second).toBeNull();
  });

  it.each([
    [
      "macOS refused the move",
      [
        "2026-10-31T01:00:00Z waiting for TableCraft (pid 1) to quit",
        "mv: rename /Applications/TableCraft.app to /Applications/TableCraft.app.update-backup: Operation not permitted",
        "2026-10-31T01:00:01Z the installed app could not be moved aside; nothing was replaced",
      ],
      { reason: "the installed app could not be moved aside; nothing was replaced", denied: true },
    ],
    [
      "a later swap succeeded",
      [
        "2026-10-31T01:00:01Z the installed app could not be moved aside; nothing was replaced",
        "2026-10-31T02:00:00Z replaced; relaunching",
      ],
      null,
    ],
    ["the swap succeeded", ["2026-10-31T02:00:00Z replaced; relaunching"], null],
  ])("givenSwapLogWhere %s_whenDrained_thenTheFailureIsReturned", async (_what, swapLines, expected) => {
    const files = new Map([["/p/update-swap.log", `${swapLines.join("\n")}\n`]]);
    const store = {
      readText: (path: string) => Promise.resolve(files.get(path) ?? null),
      writeText: () => Promise.resolve(),
      remove: (path: string) => {
        files.delete(path);
        return Promise.resolve();
      },
    };

    expect(await drainSwapLog("/p/update-swap.log", store, recordingLogger([]))).toEqual(expected);
  });
});

describe("update manifest script", () => {
  it.each([
    ["TableCraft-0.2.0-arm64.zip", "darwin-arm64"],
    ["TableCraft-0.2.0-x64.zip", "darwin-x64"],
    ["TableCraft-0.2.0-x64.exe", "win32-x64"],
    ["TableCraft-0.2.0-x86_64.AppImage", "linux-x64"],
    ["TableCraft-0.2.0-arm64.dmg", null],
    ["TableCraft-0.2.0-arm64.zip.blockmap", null],
    ["TableCraft-0.1.0-arm64.zip", null],
  ])("givenInstaller %s_whenNamed_thenKey %s", (name, key) => {
    expect(installerKey(name, "0.2.0")).toBe(key);
  });

  it.each([
    ["TableCraft-0.2.0-beta.1-arm64.zip", "darwin-arm64"],
    ["TableCraft-0.2.0-beta.1-x64.exe", "win32-x64"],
    ["TableCraft-0.2.0-arm64.zip", null],
  ])("givenBetaInstaller %s_whenNamed_thenKey %s", (name, key) => {
    expect(installerKey(name, "0.2.0-beta.1")).toBe(key);
  });

  it.each([
    ["0.2.0", "stable"],
    ["0.2.0-beta.1", "beta"],
  ])("givenVersion %s_whenSigned_thenManifestChannel %s", (version, channel) => {
    const body = manifestBody({
      version,
      notesUrl: NOTES_URL,
      minimumVersion: null,
      baseUrl: `https://updates.example/releases/download/v${version}/`,
      installers: [{ name: `TableCraft-${version}-arm64.zip`, size: 10, sha256: "a".repeat(64) }],
    });

    const verdict = verifyManifest(body, signBody(body, KEYS.privatePem), TRUST);

    expect(verdict.ok && verdict.manifest.channel).toBe(channel);
  });

  it("givenInstallers_whenSigned_thenTheAppVerifiesTheManifest", () => {
    const body = manifestBody({
      version: "0.2.0",
      notesUrl: NOTES_URL,
      minimumVersion: null,
      baseUrl: "https://updates.example/releases/download/v0.2.0/",
      installers: [
        { name: "TableCraft-0.2.0-arm64.zip", size: 10, sha256: "a".repeat(64) },
        { name: "TableCraft-0.2.0-arm64.dmg", size: 10, sha256: "b".repeat(64) },
      ],
    });

    const verdict = verifyManifest(body, signBody(body, KEYS.privatePem), TRUST);

    expect(verdict.ok && Object.keys(verdict.manifest.assets)).toEqual(["darwin-arm64"]);
  });

  it("givenNoInstallers_whenBuilt_thenItFailsSayingWhatToBuild", () => {
    const build = () =>
      manifestBody({
        version: "0.2.0",
        notesUrl: NOTES_URL,
        minimumVersion: null,
        baseUrl: "https://x/",
        installers: [],
      });

    expect(build).toThrow(ManifestScriptError);
    expect(build).toThrow(/build the installers first/);
  });
});

describe("beta channel manifest script", () => {
  const TAG = "v0.3.0-beta.2";

  function candidate(overrides: Record<string, unknown> = {}, published: string | null = null, keys = KEYS) {
    const { body, signature } = signed(
      manifestDocument({ version: "0.3.0-beta.2", channel: "beta", ...overrides }),
      keys,
    );
    return {
      tag: TAG,
      body,
      signature,
      published: published === null ? null : Buffer.from(JSON.stringify({ version: published })),
    };
  }

  it.each([
    [null, "publish"],
    ["0.3.0-beta.1", "publish"],
    ["0.2.0", "publish"],
    ["0.3.0-beta.2", "unchanged"],
  ] as const)("givenPublished %s_whenChecked_then %s", (published, verdict) => {
    expect(checkBetaManifest(candidate({}, published), TRUST)).toBe(verdict);
  });

  it.each([
    ["an older beta is published", candidate({}, "0.3.0-beta.3"), /already offers 0\.3\.0-beta\.3/],
    ["a newer stable is published", candidate({}, "0.3.0"), /already offers 0\.3\.0;/],
    ["the version differs from the tag", candidate({ version: "0.3.0-beta.1" }), /names 0\.3\.0-beta\.1, the tag/],
    ["the manifest is stable", candidate({ channel: "stable" }), /stable channel/],
    ["the signature is another key's", candidate({}, null, OTHER_KEYS), /does not verify \(signature/],
    ["the tag is stable", { ...candidate(), tag: "v0.3.0" }, /vX\.Y\.Z-beta\.N/],
  ])("given %s_whenChecked_thenRefused", (_case, input, message) => {
    expect(() => checkBetaManifest(input, TRUST)).toThrow(ChannelManifestError);
    expect(() => checkBetaManifest(input, TRUST)).toThrow(message);
  });

  it("givenAnUnreadablePublishedFile_whenChecked_thenPublished", () => {
    expect(checkBetaManifest({ ...candidate(), published: Buffer.from("<html>") }, TRUST)).toBe("publish");
  });
});
