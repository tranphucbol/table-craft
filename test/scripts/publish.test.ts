import { describe, expect, it } from "vitest";
import {
  alreadyPublished,
  distTagFor,
  publishPackages,
  PublishError,
  releaseNotes,
  type Npm,
  type NpmResult,
  type PackageTarball,
} from "../../scripts/plugins/publish.js";

const PLUGIN_API: PackageTarball = {
  file: "/p/tablecraft-app-plugin-api-1.0.0.tgz",
  name: "@tablecraft-app/plugin-api",
  version: "1.0.0",
};
const POSTGRES: PackageTarball = {
  file: "/p/tablecraft-app-plugin-postgres-0.4.0.tgz",
  name: "@tablecraft-app/plugin-postgres",
  version: "0.4.0",
};
const ORACLE: PackageTarball = {
  file: "/p/tablecraft-app-plugin-oracle-0.4.0.tgz",
  name: "@tablecraft-app/plugin-oracle",
  version: "0.4.0",
};
const OK: NpmResult = { status: 0, stdout: "", stderr: "" };
const NOT_FOUND: NpmResult = { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };

/** A fake npm whose registry holds `published` ("name@version"); records every call. */
function fakeNpm(published: readonly string[] = [], publishResult: NpmResult = OK) {
  const calls: string[][] = [];
  const npm: Npm = (args) => {
    calls.push([...args]);
    if (args[0] === "view") return published.includes(args[1] ?? "") ? { ...OK, stdout: '"x"\n' } : NOT_FOUND;
    return publishResult;
  };
  return { npm, calls, publishes: () => calls.filter((call) => call[0] === "publish") };
}

describe("publishing plugins", () => {
  it("givenPluginsAndPluginApi_whenPublished_thenPluginApiGoesFirst", () => {
    const registry = fakeNpm();

    publishPackages({ packages: [POSTGRES, ORACLE, PLUGIN_API], dryRun: false, provenance: true, npm: registry.npm });

    expect(registry.publishes().map((call) => call[1])).toEqual([PLUGIN_API.file, ORACLE.file, POSTGRES.file]);
    expect(registry.publishes()[0]).toEqual([
      "publish",
      PLUGIN_API.file,
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
    ]);
  });

  it("givenVersionAlreadyOnTheRegistry_whenPublished_thenSkippedSoARerunIsSafe", () => {
    const registry = fakeNpm(["@tablecraft-app/plugin-api@1.0.0"]);

    const outcomes = publishPackages({
      packages: [PLUGIN_API, POSTGRES],
      dryRun: false,
      provenance: false,
      npm: registry.npm,
    });

    expect(outcomes.map((entry) => [entry.name, entry.status])).toEqual([
      ["@tablecraft-app/plugin-api", "skipped"],
      ["@tablecraft-app/plugin-postgres", "published"],
    ]);
    expect(registry.publishes().map((call) => call[1])).toEqual([POSTGRES.file]);
  });

  it("givenDryRun_whenPublished_thenEveryPublishCarriesDryRun", () => {
    const registry = fakeNpm();

    publishPackages({ packages: [PLUGIN_API, POSTGRES], dryRun: true, provenance: false, npm: registry.npm });

    expect(registry.publishes().every((call) => call.includes("--dry-run"))).toBe(true);
  });

  it.each([
    ["0.4.0", "latest"],
    ["0.5.0-beta.1", "next"],
    ["0.0.0-dev.abc1234", "next"],
  ])("givenVersion%s_whenTagged_thenDistTagIs%s", (version, tag) => {
    expect(distTagFor(version)).toBe(tag);
  });

  it("givenExplicitDistTag_whenPublished_thenItOverridesTheVersionsTag", () => {
    const registry = fakeNpm();

    publishPackages({ packages: [POSTGRES], dryRun: false, provenance: false, distTag: "next", npm: registry.npm });

    expect(registry.publishes()[0]).toContain("next");
  });

  it("givenRegistryUnreachable_whenChecked_thenFailsInsteadOfGuessing", () => {
    const npm: Npm = () => ({ status: 1, stdout: "", stderr: "npm error code ECONNREFUSED" });

    expect(() => alreadyPublished(npm, POSTGRES.name, POSTGRES.version)).toThrow(PublishError);
  });

  it("givenPublishFails_whenPublished_thenStopsAndSaysRerunIsSafe", () => {
    const registry = fakeNpm([], { status: 1, stdout: "", stderr: "npm error code E403" });

    expect(() =>
      publishPackages({ packages: [PLUGIN_API, POSTGRES], dryRun: false, provenance: false, npm: registry.npm }),
    ).toThrow(/rerun; published versions are skipped/);
    expect(registry.publishes()).toHaveLength(1);
  });

  it("givenOutcomes_whenNoted_thenEachVersionLinksToNpm", () => {
    const notes = releaseNotes([
      { ...PLUGIN_API, status: "skipped", distTag: "latest" },
      { ...POSTGRES, status: "published", distTag: "latest" },
    ]);

    expect(notes).toContain("### Plugins on npm");
    expect(notes).toContain(
      "- [`@tablecraft-app/plugin-postgres@0.4.0`](https://www.npmjs.com/package/@tablecraft-app/plugin-postgres/v/0.4.0) (`latest`)",
    );
    expect(notes).toContain("`@tablecraft-app/plugin-api@1.0.0`");
    expect(notes).toContain("(already published)");
  });

  it("givenReusedPackage_whenReleaseNotes_thenUnchangedStill", () => {
    const notes = releaseNotes(
      [
        { ...POSTGRES, status: "skipped", distTag: "latest" },
        { ...ORACLE, version: "0.5.0", status: "skipped", distTag: "latest" },
        { ...PLUGIN_API, version: "0.5.0", status: "published", distTag: "latest" },
      ],
      "0.5.0",
    );

    expect(notes).toContain(
      "plugin-postgres@0.4.0`](https://www.npmjs.com/package/@tablecraft-app/plugin-postgres/v/0.4.0) (unchanged, still `0.4.0`)",
    );
    expect(notes).toContain(
      "plugin-oracle@0.5.0`](https://www.npmjs.com/package/@tablecraft-app/plugin-oracle/v/0.5.0) (already published)",
    );
    expect(notes).toContain(
      "plugin-api@0.5.0`](https://www.npmjs.com/package/@tablecraft-app/plugin-api/v/0.5.0) (`latest`)",
    );
  });
});
