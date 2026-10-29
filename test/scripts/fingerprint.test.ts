import { describe, expect, it } from "vitest";
import {
  fingerprintDifferences,
  FingerprintError,
  pluginFingerprint,
  tarballFingerprint,
} from "../../scripts/plugins/fingerprint.js";
import { pluginTarball, tarball } from "../support/pluginRegistry.js";

const README = { path: "package/README.md", data: "# plugin\n" };

describe("plugin fingerprint", () => {
  it("givenSameFilesDifferentVersion_whenFingerprint_thenEqual", () => {
    const old = tarballFingerprint(pluginTarball({ id: "postgres", version: "1.15.0" }));
    const next = tarballFingerprint(pluginTarball({ id: "postgres", version: "1.16.0-beta.1" }));

    expect(next).toBe(old);
  });

  it("givenOneByteChanged_whenFingerprint_thenDiffers", () => {
    const old = tarballFingerprint(
      pluginTarball({ id: "postgres", version: "1.15.0", indexJs: "export default 1;\n" }),
    );
    const next = tarballFingerprint(
      pluginTarball({ id: "postgres", version: "1.16.0", indexJs: "export default 2;\n" }),
    );

    expect(next).not.toBe(old);
  });

  it("givenReadmeChanged_whenFingerprint_thenDiffers", () => {
    const old = tarballFingerprint(pluginTarball({ id: "postgres", version: "1.15.0", extra: [README] }));
    const next = tarballFingerprint(
      pluginTarball({ id: "postgres", version: "1.16.0", extra: [{ ...README, data: "# plugin, renamed\n" }] }),
    );

    expect(next).not.toBe(old);
  });

  it("givenApiVersionChanged_whenFingerprint_thenDiffers", () => {
    const old = tarballFingerprint(pluginTarball({ id: "postgres", version: "1.15.0", apiVersion: "1.0.0" }));
    const next = tarballFingerprint(pluginTarball({ id: "postgres", version: "1.16.0", apiVersion: "1.1.0" }));

    expect(next).not.toBe(old);
  });

  it("givenSameFilesInAnotherOrderAndKeyOrder_whenFingerprint_thenEqual", () => {
    const one = pluginFingerprint([
      { path: "package.json", data: Buffer.from('{"name":"a","version":"1.0.0","main":"index.js"}') },
      { path: "index.js", data: Buffer.from("x") },
    ]);
    const other = pluginFingerprint([
      { path: "index.js", data: Buffer.from("x") },
      { path: "package.json", data: Buffer.from('{\n  "main": "index.js",\n  "version": "2.0.0",\n  "name": "a"\n}') },
    ]);

    expect(other).toBe(one);
  });

  it("givenFileMovedIntoAnother_whenFingerprint_thenDiffers", () => {
    const one = pluginFingerprint([
      { path: "a", data: Buffer.from("bc") },
      { path: "d", data: Buffer.from("") },
    ]);
    const other = pluginFingerprint([
      { path: "a", data: Buffer.from("b") },
      { path: "d", data: Buffer.from("c") },
    ]);

    expect(other).not.toBe(one);
  });

  it("givenPackageJsonNotJson_whenFingerprint_thenRefusedNamingTheFile", () => {
    const bytes = tarball([{ path: "package/package.json", data: "not json" }]);

    expect(() => tarballFingerprint(bytes)).toThrow(FingerprintError);
    expect(() => tarballFingerprint(bytes)).toThrow(/package\.json/);
  });

  it("givenTwoPacks_whenCompared_thenOnlyDifferencesAndMissingPackagesAreListed", () => {
    const left = new Map([
      ["@tablecraft-app/plugin-postgres", "aa"],
      ["@tablecraft-app/plugin-redis", "bb"],
      ["@tablecraft-app/plugin-oracle", "cc"],
    ]);
    const right = new Map([
      ["@tablecraft-app/plugin-postgres", "aa"],
      ["@tablecraft-app/plugin-redis", "bx"],
    ]);

    expect(fingerprintDifferences(left, right)).toEqual([
      "@tablecraft-app/plugin-oracle was packed only once",
      "@tablecraft-app/plugin-redis packs differently from the same source (bb vs bx)",
    ]);
  });
});
