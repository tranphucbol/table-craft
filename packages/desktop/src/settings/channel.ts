/**
 * Release channels (plan 124): a beta is `X.Y.Z-beta.N`, tagged `vX.Y.Z-beta.N`; anything else,
 * a `0.0.0-dev.<sha>` branch build included, is stable. Pure, so main, the renderer and the release
 * scripts classify a version the same way.
 */
export const RELEASE_CHANNELS = ["stable", "beta"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** `X.Y.Z-beta.N`; no other pre-release identifier is a channel. */
export const BETA_VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/;

export function channelOf(version: string): ReleaseChannel {
  return BETA_VERSION.test(version) ? "beta" : "stable";
}

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly unknown[]).includes(value);
}
