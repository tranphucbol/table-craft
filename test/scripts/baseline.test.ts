import { afterEach, describe, expect, it } from "vitest";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { baselineFor } from "../../scripts/plugins/baseline.js";
import { pluginPackageName, release, sha512, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";

const POSTGRES = pluginPackageName("postgres");
const PUBLISHED = ["1.14.0", "1.16.0-beta.1", "1.15.0", "1.16.0-beta.2", "0.0.0-dev.abc1234"].map((version) =>
  release({ id: "postgres", version }),
);

describe("plugin publish baseline", () => {
  let registry: LoopbackRegistry | undefined;

  afterEach(async () => {
    await registry?.close();
    registry = undefined;
  });

  async function serving(releases = PUBLISHED): Promise<LoopbackRegistry> {
    registry = await startRegistry({ [POSTGRES]: releases });
    return registry;
  }

  it("givenStableAndBetaPublished_whenStableBaseline_thenNewestStable", async () => {
    const { url } = await serving();

    const baseline = await baselineFor(POSTGRES, "stable", fetch, url);

    expect(baseline?.version).toBe("1.15.0");
    expect(baseline?.bytes.equals(PUBLISHED[2]?.bytes ?? Buffer.alloc(0))).toBe(true);
    expect(baseline?.integrity).toBe(sha512(PUBLISHED[2]?.bytes ?? Buffer.alloc(0)));
  });

  it("givenStableAndBetaPublished_whenBetaBaseline_thenNewestOfAny", async () => {
    const { url } = await serving();

    const baseline = await baselineFor(POSTGRES, "beta", fetch, url);

    expect(baseline?.version).toBe("1.16.0-beta.2");
  });

  it("givenStableNewerThanBetas_whenBetaBaseline_thenTheStable", async () => {
    const { url } = await serving([
      release({ id: "postgres", version: "1.16.0-beta.2" }),
      release({ id: "postgres", version: "1.16.0" }),
    ]);

    const baseline = await baselineFor(POSTGRES, "beta", fetch, url);

    expect(baseline?.version).toBe("1.16.0");
  });

  it("givenOnlyBetasPublished_whenStableBaseline_thenNone", async () => {
    const { url } = await serving([release({ id: "postgres", version: "1.16.0-beta.1" })]);

    await expect(baselineFor(POSTGRES, "stable", fetch, url)).resolves.toBeNull();
  });

  it("givenNeverPublished_whenBaseline_thenNone", async () => {
    const { url } = await serving();

    await expect(baselineFor(pluginPackageName("oracle"), "stable", fetch, url)).resolves.toBeNull();
  });

  it("givenBadIntegrity_whenBaseline_thenFails", async () => {
    const { url } = await serving([release({ id: "postgres", version: "1.15.0" }, "sha512-tampered")]);

    const failure = baselineFor(POSTGRES, "stable", fetch, url);

    await expect(failure).rejects.toBeInstanceOf(PluginInstallError);
    await expect(failure).rejects.toMatchObject({ failure: "integrity" });
  });

  it("givenRegistryDown_whenBaseline_thenFailsOffline", async () => {
    const { url } = await serving();
    await registry?.close();
    registry = undefined;

    await expect(baselineFor(POSTGRES, "stable", fetch, url)).rejects.toMatchObject({ failure: "offline" });
  });
});
