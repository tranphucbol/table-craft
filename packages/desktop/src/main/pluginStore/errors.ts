/** Why a plugin could not be installed, updated or removed (decision 110). */
export type PluginInstallFailure =
  | "offline"
  | "notFound"
  | "incompatible"
  | "integrity"
  | "unsafeEntry"
  | "tooLarge"
  | "diskFull"
  | "invalid"
  | "insecureUrl"
  | "inUse"
  | "builtIn";

/** A failure the user can act on; `hint` says what to do next, as `DatasourceError`'s does. */
export class PluginInstallError extends Error {
  override readonly name = "PluginInstallError";
  constructor(
    readonly failure: PluginInstallFailure,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export const OFFLINE_HINT =
  "Check the connection, or use Install from File… in Settings → Plugins with the plugin's .tgz.";
