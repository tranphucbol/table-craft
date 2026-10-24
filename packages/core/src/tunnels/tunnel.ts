import { readFile as readFileFromDisk } from "node:fs/promises";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";
import { TunnelError } from "@table-craft/core/errors.js";
import { hostKeyOffer, type HostKeyVerifier } from "@table-craft/core/tunnels/hostKeys.js";

export const SSH_AUTH_METHODS = ["password", "key", "agent"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/** The bastion and how to log in to it; secrets arrive decrypted, from main only (decision 020). */
export interface SshEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuthMethod;
  readonly password?: string;
  readonly keyPath?: string;
  readonly passphrase?: string;
}

/** Where the bastion forwards to, as the bastion resolves it. */
export interface TunnelTarget {
  readonly host: string;
  readonly port: number;
}

export interface TunnelOptions {
  readonly ssh: SshEndpoint;
  readonly target: TunnelTarget;
  readonly verifyHostKey: HostKeyVerifier;
  /** Bounds the SSH handshake, not counting the time the host-key prompt waits for the user; 0 waits forever. */
  readonly timeoutMs: number;
  /** SSH keepalive interval; 0 or absent turns it off. */
  readonly keepAliveMs?: number;
  readonly readFile?: (path: string) => Promise<Buffer>;
  /** The agent socket, or `pageant`; defaults to `SSH_AUTH_SOCK`, Pageant on Windows. */
  readonly agent?: string;
}

export interface Tunnel {
  /** The loopback port that forwards to the target. */
  readonly localPort: number;
  /** Why the SSH server last refused to forward, for the database hop's error; null when it did not. */
  readonly forwardError: string | null;
  close(): Promise<void>;
  /** `reason` is null after `close()`, else why the SSH connection ended. */
  onClose(listener: (reason: string | null) => void): void;
}

const LOOPBACK = "127.0.0.1";
const PAGEANT = "pageant";
const WINDOWS = "win32";
const MS_PER_SECOND = 1_000;
const AUTH_LEVEL = "client-authentication";
const MISSING_PASSPHRASE = /no passphrase/i;

const UNREACHABLE_HINT = "Check the SSH host and port, and that this machine may reach the SSH server.";
const AUTH_HINTS: Readonly<Record<SshAuthMethod, string>> = {
  password: "Check the SSH user and password.",
  key: "Check the SSH user, and that the server accepts this key (its authorized_keys).",
  agent: "Check the SSH user, and that the agent holds a key the server accepts (ssh-add -l).",
};
const AUTH_NAMES: Readonly<Record<SshAuthMethod, string>> = {
  password: "password",
  key: "key pair",
  agent: "agent",
};

function authFailed(message: string, hint: string): TunnelError {
  return new TunnelError("sshAuthFailed", message, hint);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function keyConfig(ssh: SshEndpoint, read: (path: string) => Promise<Buffer>): Promise<Partial<ConnectConfig>> {
  const path = ssh.keyPath ?? "";
  if (path === "") {
    throw authFailed(
      "No SSH key file was chosen.",
      "Choose the private key file in the data source's SSH/SSL section.",
    );
  }
  let key: Buffer;
  try {
    key = await read(path);
  } catch (cause) {
    throw authFailed(
      `Could not read the SSH key file ${path}: ${messageOf(cause)}`,
      "Choose a private key file that exists and that you may read.",
    );
  }
  const parsed = ssh2.utils.parseKey(key, ssh.passphrase);
  if (parsed instanceof Error) {
    if (ssh.passphrase === undefined && MISSING_PASSPHRASE.test(parsed.message)) {
      throw authFailed(
        `The SSH key ${path} is encrypted and no passphrase was given.`,
        "Enter the key's passphrase in the data source's SSH/SSL section.",
      );
    }
    throw authFailed(
      `Could not use the SSH key ${path}: ${parsed.message}`,
      "Check the passphrase, and that the file is an OpenSSH or PEM private key.",
    );
  }
  return ssh.passphrase === undefined ? { privateKey: key } : { privateKey: key, passphrase: ssh.passphrase };
}

async function authConfig(options: TunnelOptions): Promise<Partial<ConnectConfig>> {
  const { ssh } = options;
  if (ssh.auth === "password") {
    if (ssh.password === undefined) {
      throw authFailed(
        `No SSH password was given for ${ssh.user}@${ssh.host}.`,
        "Enter the SSH password in the data source's SSH/SSL section.",
      );
    }
    return { password: ssh.password };
  }
  if (ssh.auth === "key") return keyConfig(ssh, options.readFile ?? readFileFromDisk);
  const agent = options.agent ?? (process.platform === WINDOWS ? PAGEANT : process.env["SSH_AUTH_SOCK"]);
  if (agent === undefined || agent === "") {
    throw authFailed(
      "No SSH agent is running: SSH_AUTH_SOCK is not set.",
      "Start ssh-agent and add your key (ssh-add), or choose Key pair or Password authentication.",
    );
  }
  return { agent };
}

function connectFailed(options: TunnelOptions, cause: Error & { level?: string }): TunnelError {
  const { ssh } = options;
  const where = `${ssh.host}:${String(ssh.port)}`;
  if (cause.level === AUTH_LEVEL) {
    return authFailed(
      `SSH authentication failed for ${ssh.user}@${where} by ${AUTH_NAMES[ssh.auth]}.`,
      AUTH_HINTS[ssh.auth],
    );
  }
  return new TunnelError(
    "sshHostUnreachable",
    `Could not reach the SSH server ${where}: ${cause.message}`,
    UNREACHABLE_HINT,
  );
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Logs in to the bastion, then forwards a loopback port to `target` through it (plan 036). */
export async function openTunnel(options: TunnelOptions): Promise<Tunnel> {
  const { ssh, target } = options;
  const auth = await authConfig(options);
  const client = new ssh2.Client();
  let lastError: Error | null = null;
  client.on("error", (error) => {
    lastError = error;
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refusal: unknown = null;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const arm = (): void => {
      if (options.timeoutMs <= 0) return;
      timer = setTimeout(() => {
        fail(
          new TunnelError(
            "sshHostUnreachable",
            `The SSH server ${ssh.host}:${String(ssh.port)} did not finish the handshake within ${String(options.timeoutMs / MS_PER_SECOND)} s.`,
            UNREACHABLE_HINT,
          ),
        );
      }, options.timeoutMs);
    };
    client.once("ready", () => {
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    client.on("error", (error: Error & { level?: string }) => {
      fail(refusal ?? connectFailed(options, error));
    });
    client.once("close", () => {
      fail(refusal ?? connectFailed(options, lastError ?? new Error("the server closed the connection")));
    });
    arm();
    client.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      ...auth,
      readyTimeout: 0,
      keepaliveInterval: options.keepAliveMs ?? 0,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        clearTimeout(timer);
        options.verifyHostKey(hostKeyOffer(ssh.host, ssh.port, key)).then(
          () => {
            if (!settled) arm();
            verify(true);
          },
          (cause: unknown) => {
            refusal = cause;
            verify(false);
          },
        );
      },
    });
  });

  const sockets = new Set<Socket>();
  const listeners = new Set<(reason: string | null) => void>();
  let forwardError: string | null = null;
  let closed = false;

  function finish(reason: string | null): void {
    if (closed) return;
    closed = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    for (const listener of listeners) listener(reason);
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    client.forwardOut(LOOPBACK, socket.remotePort ?? 0, target.host, target.port, (error, channel) => {
      if (error !== undefined && error !== null) {
        forwardError = `the SSH server could not reach ${target.host}:${String(target.port)}: ${error.message}`;
        socket.destroy();
        return;
      }
      forwardError = null;
      if (socket.destroyed) {
        channel.close();
        return;
      }
      channel.on("error", () => socket.destroy());
      channel.once("close", () => socket.destroy());
      socket.once("close", () => channel.close());
      socket.pipe(channel).pipe(socket);
    });
  });

  client.once("close", () => {
    finish(lastError === null ? "the SSH server closed the connection" : lastError.message);
  });

  let localPort: number;
  try {
    localPort = await listen(server);
  } catch (cause) {
    finish(null);
    client.end();
    throw cause;
  }

  return {
    localPort,
    get forwardError() {
      return forwardError;
    },
    close() {
      finish(null);
      client.end();
      return Promise.resolve();
    },
    onClose(listener) {
      if (closed) return;
      listeners.add(listener);
    },
  };
}
