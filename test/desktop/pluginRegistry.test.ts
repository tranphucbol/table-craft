import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  authorizedHeaders,
  candidateVersions,
  checkIntegrity,
  downloadTarball,
  fetchPackument,
  isNewerRelease,
  officialRegistry,
  packumentUrl,
  pickVersion,
  registryUrlAllowed,
  UNAUTHORIZED_HINT,
  type RegistryAccess,
  type RegistryFetch,
} from "@table-craft/desktop/main/pluginStore/registry.js";
import { readPackageTarball } from "@table-craft/desktop/main/pluginStore/tarball.js";
import { paxPath, pluginTarball, release, sha512, startRegistry, tarball } from "../support/pluginRegistry.js";

const PACKAGE = "@tablecraft-app/plugin-postgres";
const loopbackFetch: RegistryFetch = (url, init) => fetch(url, init);

function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    if (cause instanceof PluginInstallError) return cause.failure;
    throw cause;
  }
  throw new Error("expected a PluginInstallError");
}

async function rejectionOf(work: Promise<unknown>): Promise<PluginInstallError> {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof PluginInstallError) return cause;
    throw cause;
  }
  throw new Error("expected a PluginInstallError");
}

function packument(versions: Record<string, { apiVersion: string; id?: string }>): unknown {
  return {
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, { apiVersion, id }]) => [
        version,
        {
          version,
          tableCraft: { id: id ?? "postgres", apiVersion },
          dist: { tarball: `t/${version}`, integrity: "x" },
        },
      ]),
    ),
  };
}

describe("plugin tarball", () => {
  it("givenPluginPackage_whenRead_thenFilesComeOutBelowPackage", () => {
    const files = readPackageTarball(pluginTarball({ id: "postgres", version: "1.2.3" }));

    expect(files.map((file) => file.path).sort()).toEqual(["index.js", "package.json", "table-craft-plugin.json"]);
    const manifest: unknown = JSON.parse(
      files.find((file) => file.path === "table-craft-plugin.json")?.data.toString() ?? "",
    );
    expect(manifest).toMatchObject({ id: "postgres", version: "1.2.3" });
  });

  it("givenPaxPath_whenRead_thenThePaxNameWins", () => {
    const long = `package/${"deep/".repeat(30)}file.js`;
    const bytes = tarball([
      { path: "PaxHeader", type: "x", data: paxPath(long) },
      { path: "package/short", data: "body" },
    ]);

    expect(readPackageTarball(bytes).map((file) => file.path)).toEqual([long.slice("package/".length)]);
  });

  it("givenDirectoryEntries_whenRead_thenOnlyFilesComeOut", () => {
    const bytes = tarball([
      { path: "package/", type: "5" },
      { path: "package/lib/", type: "5" },
      { path: "package/lib/a.js", data: "a" },
    ]);

    expect(readPackageTarball(bytes).map((file) => file.path)).toEqual(["lib/a.js"]);
  });

  it.each([
    ["a parent path", { path: "package/../escape.js", data: "x" }],
    ["an absolute path", { path: "/etc/passwd", data: "x" }],
    ["a backslash path", { path: "package\\..\\escape.js", data: "x" }],
    ["a drive path", { path: "C:/escape.js", data: "x" }],
    ["a path outside package/", { path: "other/file.js", data: "x" }],
    ["a symlink", { path: "package/link", type: "2", linkName: "/etc/passwd" }],
    ["a hard link", { path: "package/link", type: "1", linkName: "package/index.js" }],
    ["a device", { path: "package/dev", type: "3" }],
  ])("givenTarballWith%s_whenRead_thenTheWholeTarballIsRefused", (_, entry) => {
    const bytes = tarball([{ path: "package/index.js", data: "ok" }, entry]);

    expect(failureOf(() => readPackageTarball(bytes))).toBe("unsafeEntry");
  });

  it("givenBytesThatAreNotGzip_whenRead_thenInvalid", () => {
    expect(failureOf(() => readPackageTarball(Buffer.from("not a tarball")))).toBe("invalid");
  });

  it("givenCorruptHeaderChecksum_whenRead_thenInvalid", async () => {
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const raw = gunzipSync(tarball([{ path: "package/index.js", data: "ok" }]));
    raw[0] = "q".charCodeAt(0);

    expect(failureOf(() => readPackageTarball(gzipSync(raw)))).toBe("invalid");
  });
});

describe("plugin registry", () => {
  it("givenScopedPackage_whenPackumentUrl_thenSlashIsEscaped", () => {
    expect(packumentUrl("https://registry.npmjs.org/", PACKAGE)).toBe(
      "https://registry.npmjs.org/@tablecraft-app%2fplugin-postgres",
    );
  });

  it.each([
    ["https://registry.npmjs.org", true],
    ["https://npm.example.com/registry", true],
    ["http://127.0.0.1:4873", true],
    ["http://localhost:4873", true],
    ["http://[::1]:4873", true],
    ["http://registry.npmjs.org", false],
    ["ftp://registry.npmjs.org", false],
    ["registry.npmjs.org", false],
  ])("givenRegistry%s_whenAllowed_then%s", (url, allowed) => {
    expect(registryUrlAllowed(url)).toBe(allowed);
  });

  it("givenSeveralVersions_whenPicked_thenNewestCompatibleReleaseWins", () => {
    const picked = pickVersion(
      packument({
        "1.0.0": { apiVersion: "1.0.0" },
        "1.4.0": { apiVersion: "1.0.0" },
        "1.10.0": { apiVersion: "1.0.0" },
        "2.0.0-rc.1": { apiVersion: "1.0.0" },
        "3.0.0": { apiVersion: "2.0.0" },
        "1.11.0": { apiVersion: "1.0.0", id: "other" },
      }),
      "postgres",
      PACKAGE,
      "1.0.0",
    );

    expect(picked.version).toBe("1.10.0");
  });

  it.each([
    ["stable", "1.10.0"],
    ["beta", "1.11.0-beta.2"],
  ] as const)("given%sChannel_whenPicked_thenNewestOnThatChannel", (channel, version) => {
    const picked = pickVersion(
      packument({
        "1.10.0": { apiVersion: "1.0.0" },
        "1.11.0-beta.1": { apiVersion: "1.0.0" },
        "1.11.0-beta.2": { apiVersion: "1.0.0" },
        "1.11.0-rc.1": { apiVersion: "1.0.0" },
        "1.12.0-beta.1": { apiVersion: "2.0.0" },
      }),
      "postgres",
      PACKAGE,
      "1.0.0",
      channel,
    );

    expect(picked.version).toBe(version);
  });

  it("givenBetaChannelAndStableAfterBeta_whenPicked_thenStableWins", () => {
    const picked = pickVersion(
      packument({ "1.11.0-beta.2": { apiVersion: "1.0.0" }, "1.11.0": { apiVersion: "1.0.0" } }),
      "postgres",
      PACKAGE,
      "1.0.0",
      "beta",
    );

    expect(picked.version).toBe("1.11.0");
  });

  it("givenOnlyNewerApiVersions_whenPicked_thenIncompatibleAsksForAnAppUpdate", () => {
    try {
      pickVersion(packument({ "3.0.0": { apiVersion: "2.0.0" } }), "postgres", PACKAGE, "1.0.0");
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(PluginInstallError);
      expect((cause as PluginInstallError).failure).toBe("incompatible");
      expect((cause as PluginInstallError).hint).toContain("Update TableCraft");
    }
  });

  it("givenNoTableCraftVersions_whenPicked_thenNotFound", () => {
    expect(failureOf(() => pickVersion({ versions: {} }, "postgres", PACKAGE))).toBe("notFound");
  });

  it.each([
    ["1.2.0", "1.1.9", true],
    ["1.10.0", "1.9.0", true],
    ["1.2.0", "1.2.0", false],
    ["1.2.0-rc.1", "1.1.0", false],
    ["1.0.0", "0.0.0-dev.abc", true],
  ])("given%s_whenComparedWith%s_thenNewerIs%s", (version, than, expected) => {
    expect(isNewerRelease(version, than)).toBe(expected);
  });

  it("givenLoopbackRegistry_whenFetched_thenPackumentAndTarballArrive", async () => {
    const published = release({ id: "postgres", version: "1.0.0" });
    const registry = await startRegistry({ [PACKAGE]: [published] });
    try {
      const access = officialRegistry(registry.url);
      const document = await fetchPackument(loopbackFetch, access, PACKAGE);
      const picked = pickVersion(document, "postgres", PACKAGE);
      const progress: number[] = [];
      const bytes = await downloadTarball(loopbackFetch, access, picked.tarball, (received) => progress.push(received));

      expect(bytes.equals(published.bytes)).toBe(true);
      expect(progress.at(-1)).toBe(published.bytes.length);
      expect(() => checkIntegrity(bytes, { integrity: picked.integrity }, PACKAGE, false)).not.toThrow();
    } finally {
      await registry.close();
    }
  });

  it("givenUnknownPackage_whenFetched_thenNotFound", async () => {
    const registry = await startRegistry();
    try {
      const error = await rejectionOf(fetchPackument(loopbackFetch, officialRegistry(registry.url), PACKAGE));
      expect(error.failure).toBe("notFound");
    } finally {
      await registry.close();
    }
  });

  it("givenClosedRegistry_whenFetched_thenOfflineWithTheFileHint", async () => {
    const registry = await startRegistry();
    await registry.close();

    const error = await rejectionOf(fetchPackument(loopbackFetch, officialRegistry(registry.url), PACKAGE));
    expect(error.failure).toBe("offline");
    expect(error.hint).toContain("Install from File");
  });

  it("givenPlainHttpRemoteRegistry_whenFetched_thenRefusedBeforeAnyRequest", async () => {
    let called = false;
    const spy: RegistryFetch = () => {
      called = true;
      return Promise.reject(new Error("unreachable"));
    };

    const error = await rejectionOf(fetchPackument(spy, officialRegistry("http://registry.npmjs.org"), PACKAGE));
    expect(error.failure).toBe("insecureUrl");
    expect(called).toBe(false);
  });

  it("givenTamperedBytes_whenChecked_thenIntegrityFails", () => {
    const bytes = pluginTarball({ id: "postgres", version: "1.0.0" });
    const other = pluginTarball({ id: "postgres", version: "1.0.1" });

    expect(failureOf(() => checkIntegrity(bytes, { integrity: sha512(other) }, PACKAGE, false))).toBe("integrity");
    expect(failureOf(() => checkIntegrity(bytes, { integrity: "sha1-abc" }, PACKAGE, false))).toBe("integrity");
    expect(() => checkIntegrity(bytes, { integrity: `sha1-abc ${sha512(bytes)}` }, PACKAGE, false)).not.toThrow();
  });
});

describe("private registry", () => {
  const PRIVATE = "@acme/tablecraft-plugin-example";
  const TOKEN = "glpat-test-token";
  const PREFIX = "/api/v4/packages/npm";
  const example = () => release({ id: "example", version: "1.0.0", name: PRIVATE, manifest: { id: "example" } });

  function privateAccess(url: string, token: string | null = TOKEN): RegistryAccess {
    return { url, token, private: true };
  }

  it("givenPathPrefix_whenFetchingPackument_thenUrlKeepsPrefix", async () => {
    const registry = await startRegistry({ [PRIVATE]: [example()] }, { prefix: PREFIX });
    try {
      const document = await fetchPackument(loopbackFetch, privateAccess(registry.url, null), PRIVATE);

      expect((document as { name: string }).name).toBe(PRIVATE);
      expect(registry.requests).toEqual([`${PREFIX}/@acme%2ftablecraft-plugin-example`]);
    } finally {
      await registry.close();
    }
  });

  it("givenToken_whenSameOrigin_thenAuthorizationSent", async () => {
    const registry = await startRegistry({ [PRIVATE]: [example()] }, { prefix: PREFIX, token: TOKEN, gitlab: true });
    try {
      const access = privateAccess(registry.url);
      const [candidate] = candidateVersions(await fetchPackument(loopbackFetch, access, PRIVATE), PRIVATE, "stable");
      await downloadTarball(loopbackFetch, access, candidate?.tarball ?? "", () => undefined);

      expect(registry.received.map((request) => request.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
      expect(authorizedHeaders(access, "https://elsewhere.example/x")).toEqual({});
    } finally {
      await registry.close();
    }
  });

  it("givenToken_whenTarballOnOtherOrigin_thenNoAuthorization", async () => {
    const published = example();
    const registry = await startRegistry({ [PRIVATE]: [published] }, { token: TOKEN, tarballsElsewhere: true });
    try {
      const access = privateAccess(registry.url);
      const [candidate] = candidateVersions(await fetchPackument(loopbackFetch, access, PRIVATE), PRIVATE, "stable");
      const bytes = await downloadTarball(loopbackFetch, access, candidate?.tarball ?? "", () => undefined);

      expect(bytes.equals(published.bytes)).toBe(true);
      const tarballRequest = registry.received.at(-1);
      expect(tarballRequest?.host).toBe("localhost");
      expect(tarballRequest?.authorization).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("givenCrossOriginRedirect_whenTokenSet_thenRefused", async () => {
    const registry = await startRegistry({ [PRIVATE]: [example()] }, { token: TOKEN, redirectTarballs: true });
    try {
      const access = privateAccess(registry.url);
      const [candidate] = candidateVersions(await fetchPackument(loopbackFetch, access, PRIVATE), PRIVATE, "stable");
      const error = await rejectionOf(
        downloadTarball(loopbackFetch, access, candidate?.tarball ?? "", () => undefined),
      );

      expect(error.failure).toBe("insecureUrl");
      expect(registry.received.some((request) => request.host === "localhost")).toBe(false);
    } finally {
      await registry.close();
    }
  });

  it("given401_whenFetching_thenUnauthorizedWithTokenHint", async () => {
    const registry = await startRegistry({ [PRIVATE]: [example()] }, { token: TOKEN });
    try {
      const error = await rejectionOf(fetchPackument(loopbackFetch, privateAccess(registry.url, "revoked"), PRIVATE));

      expect(error.failure).toBe("unauthorized");
      expect(error.hint).toBe(UNAUTHORIZED_HINT);
    } finally {
      await registry.close();
    }
  });

  it("givenShasumOnly_whenPrivate_thenSha1Checked", () => {
    const bytes = pluginTarball({ id: "postgres", version: "1.0.0" });
    const other = pluginTarball({ id: "postgres", version: "1.0.1" });
    const shasum = (data: Buffer) => createHash("sha1").update(data).digest("hex");

    expect(() => checkIntegrity(bytes, { shasum: shasum(bytes) }, PRIVATE, true)).not.toThrow();
    expect(failureOf(() => checkIntegrity(bytes, { shasum: shasum(other) }, PRIVATE, true))).toBe("integrity");
    expect(
      failureOf(() => checkIntegrity(bytes, { integrity: sha512(other), shasum: shasum(bytes) }, PRIVATE, true)),
    ).toBe("integrity");
  });

  it("givenShasumOnly_whenOfficial_thenIntegrityError", () => {
    const bytes = pluginTarball({ id: "postgres", version: "1.0.0" });

    const shasum = createHash("sha1").update(bytes).digest("hex");
    expect(failureOf(() => checkIntegrity(bytes, { shasum }, PACKAGE, false))).toBe("integrity");
  });

  it("givenUnknownPackage_whenRedirectedToNpmjs_thenNotFound", async () => {
    const registry = await startRegistry({}, { prefix: PREFIX, token: TOKEN, gitlab: true });
    try {
      const error = await rejectionOf(fetchPackument(loopbackFetch, privateAccess(registry.url), PRIVATE));

      expect(error.failure).toBe("notFound");
      expect(registry.received.some((request) => request.host === "localhost")).toBe(false);
    } finally {
      await registry.close();
    }
  });

  it("givenGitlabPackument_whenListed_thenNewestFirstWithoutTableCraft", () => {
    const document = {
      versions: {
        "1.0.0": { version: "1.0.0", dist: { tarball: "t/1", shasum: "aa" } },
        "1.1.0": { version: "1.1.0", dist: { tarball: "t/2", shasum: "bb" } },
        "1.2.0": { version: "1.2.0", dist: { tarball: "t/3" } },
        "1.3.0-beta.1": { version: "1.3.0-beta.1", dist: { tarball: "t/4", shasum: "cc" } },
      },
    };

    expect(candidateVersions(document, PRIVATE, "stable").map((entry) => [entry.version, entry.tableCraft])).toEqual([
      ["1.1.0", null],
      ["1.0.0", null],
    ]);
    expect(candidateVersions(document, PRIVATE, "beta")[0]?.version).toBe("1.3.0-beta.1");
    expect(failureOf(() => candidateVersions({ versions: {} }, PRIVATE, "stable"))).toBe("notFound");
  });
});
