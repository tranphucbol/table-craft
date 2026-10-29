import { describe, expect, it } from "vitest";
import { appVersion, notesStartTag, previousTag, VersionError } from "../../packages/desktop/scripts/version.js";
import { channelOf } from "@table-craft/desktop/settings/channel.js";
import type { Git } from "../../packages/desktop/scripts/version.js";

const SHORT_SHA = "8379c80";

function gitWithTags(...tags: string[]): Git {
  return (args) => {
    if (args[0] === "tag") return tags.join("\n");
    if (args[0] === "rev-parse") return SHORT_SHA;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

describe("app version", () => {
  it("givenTaggedHead_whenVersionComputed_thenTagWithoutV", () => {
    expect(appVersion(gitWithTags("v1.2.3"))).toBe("1.2.3");
  });

  it("givenUntaggedHead_whenVersionComputed_thenDevPrereleaseWithSha", () => {
    expect(appVersion(gitWithTags())).toBe(`0.0.0-dev.${SHORT_SHA}`);
  });

  it("givenNonReleaseTagOnHead_whenVersionComputed_thenDevPrereleaseWithSha", () => {
    expect(appVersion(gitWithTags("nightly", "v1.2"))).toBe(`0.0.0-dev.${SHORT_SHA}`);
  });

  it("givenTwoTagsOnHead_whenVersionComputed_thenFailsNamingBoth", () => {
    const compute = () => appVersion(gitWithTags("v1.0.0", "v1.0.1"));

    expect(compute).toThrow(VersionError);
    expect(compute).toThrow(/v1\.0\.0, v1\.0\.1/);
  });

  it("givenBetaTag_whenVersionComputed_thenPrereleaseVersion", () => {
    expect(appVersion(gitWithTags("v1.16.0-beta.2"))).toBe("1.16.0-beta.2");
  });

  it("givenStableAndBetaTagsOnHead_whenVersionComputed_thenStableWins", () => {
    expect(appVersion(gitWithTags("v1.16.0-beta.3", "v1.16.0"))).toBe("1.16.0");
  });

  it("givenTwoBetaTagsOnHead_whenVersionComputed_thenFailsNamingBoth", () => {
    const compute = () => appVersion(gitWithTags("v1.16.0-beta.1", "v1.16.0-beta.2"));

    expect(compute).toThrow(VersionError);
    expect(compute).toThrow(/v1\.16\.0-beta\.1, v1\.16\.0-beta\.2/);
  });

  it.each(["v1.16.0-rc.1", "v1.16.0-alpha.1", "v1.16.0-beta"])(
    "givenOtherPrereleaseTag %s_whenVersionComputed_thenDevPrereleaseWithSha",
    (tag) => {
      expect(appVersion(gitWithTags(tag))).toBe(`0.0.0-dev.${SHORT_SHA}`);
    },
  );
});

describe("release tags", () => {
  const TAGS = ["v1.14.0", "v1.15.0", "v1.16.0-beta.1", "v1.16.0-beta.2", "nightly", "v1.16.0", "v1.17.0-beta.1"];

  it.each([
    ["v1.16.0", "stable", "v1.15.0"],
    ["v1.16.0", "any", "v1.16.0-beta.2"],
    ["v1.16.0-beta.2", "any", "v1.16.0-beta.1"],
    ["v1.16.0-beta.1", "beta", null],
    ["v1.14.0", "any", null],
  ] as const)("givenTag %s and channel %s_whenPreviousTag_thenTag %s", (tag, channel, previous) => {
    expect(previousTag(TAGS, tag, channel)).toBe(previous);
  });

  it.each([
    ["v1.16.0", "v1.15.0"],
    ["v1.16.0-beta.1", "v1.15.0"],
    ["v1.16.0-beta.2", "v1.16.0-beta.1"],
    ["v1.17.0-beta.1", "v1.16.0"],
  ])("givenTag %s_whenNotesStart_thenTag %s", (tag, start) => {
    expect(notesStartTag(TAGS, tag)).toBe(start);
  });

  it("givenNonReleaseTag_whenNotesStart_thenFailsSayingTheForm", () => {
    expect(() => notesStartTag(TAGS, "nightly")).toThrow(/vX\.Y\.Z-beta\.N/);
  });

  it.each([
    ["1.16.0-beta.2", "beta"],
    ["1.16.0", "stable"],
    ["0.0.0-dev.8379c80", "stable"],
    ["1.16.0-rc.1", "stable"],
  ])("givenVersion %s_whenChannelOf_thenChannel %s", (version, channel) => {
    expect(channelOf(version)).toBe(channel);
  });
});
