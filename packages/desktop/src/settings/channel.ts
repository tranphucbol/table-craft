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

/** `auto` follows the kind of build that runs, so a beta installed by hand keeps getting betas. */
export const UPDATE_CHANNEL_SETTINGS = ["auto", ...RELEASE_CHANNELS] as const;
export type UpdateChannelSetting = (typeof UPDATE_CHANNEL_SETTINGS)[number];

export function isUpdateChannelSetting(value: unknown): value is UpdateChannelSetting {
  return (UPDATE_CHANNEL_SETTINGS as readonly unknown[]).includes(value);
}

export function effectiveChannel(setting: UpdateChannelSetting, appVersion: string): ReleaseChannel {
  return setting === "auto" ? channelOf(appVersion) : setting;
}
