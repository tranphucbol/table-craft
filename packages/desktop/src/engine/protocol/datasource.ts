/**
 * The one datasource an engine host serves. Main assembles it from `datasources.json` and the
 * secret store, so `config` carries decrypted secrets and never travels to the renderer.
 */
export interface DatasourceConfig {
  readonly id: string;
  readonly pluginId: string;
  readonly config: unknown;
  /** Every session asks the database to refuse writes (decision 011). */
  readonly readOnly: boolean;
  /**
   * Seconds of silence before TCP keepalive probes on every session this host opens, and how long a
   * console session may idle before the engine pings it; 0 turns both off (decision 054).
   */
  readonly keepAliveSeconds: number;
  /** The SSH tunnel every session goes through (decision 070), its secrets decrypted; absent: direct. */
  readonly ssh?: SshTunnelConfig;
}

/** Mirrors `SshAuthMethod` in core. */
export type SshAuthMethod = "password" | "key" | "agent";

/** Mirrors `SshEndpoint` in core. */
export interface SshTunnelConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuthMethod;
  readonly password?: string;
  readonly keyPath?: string;
  readonly passphrase?: string;
}

/** What an engine posts on its parent port to ask main whether to trust an SSH host key (decision 071). */
export const ENGINE_HOST_KEY_MESSAGE = "engine.host-key";
/** What main posts back on the engine's parent port with the verdict on one host key. */
export const ENGINE_HOST_KEY_ANSWER_MESSAGE = "engine.host-key-answer";

/** Mirrors `HostKeyOffer` in core: the key an SSH server presented, `key` its base64 blob. */
export interface HostKeyOffer {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly key: string;
}

export interface EngineHostKeyRequest {
  readonly kind: typeof ENGINE_HOST_KEY_MESSAGE;
  readonly requestId: number;
  readonly offer: HostKeyOffer;
}

/**
 * `rejected`: the key was unknown and the user, or the lack of a window to ask in, declined it;
 * `changed`: a different key is on record for the host, so it was refused without asking.
 */
export type HostKeyVerdict =
  | { readonly verdict: "trusted" }
  | { readonly verdict: "rejected" }
  | { readonly verdict: "changed"; readonly knownFingerprint: string; readonly file: string };

export type EngineHostKeyAnswer = HostKeyVerdict & {
  readonly kind: typeof ENGINE_HOST_KEY_ANSWER_MESSAGE;
  readonly requestId: number;
};

/** The SSH hop of a tunnelled Test Connection (decision 070). */
export interface SshHop {
  readonly host: string;
  readonly user: string;
  readonly elapsedMs: number;
}

/** The protocol and cipher a TLS connection to the database negotiated, as Test Connection reports them. */
export interface TlsHop {
  readonly protocol: string;
  readonly cipher: string;
}
