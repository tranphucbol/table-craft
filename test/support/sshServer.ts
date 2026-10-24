/**
 * An in-process SSH server for the tunnel tests (plan 036): password and public-key users, and
 * `direct-tcpip` forwarding to whatever the client asks for. Test-only keys, generated per run.
 */
import { timingSafeEqual } from "node:crypto";
import { connect, createServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import ssh2 from "ssh2";
import type { Connection } from "ssh2";

export const SSH_USER = "tunnel";
export const SSH_PASSWORD = "tunnel-password";
export const KEY_PASSPHRASE = "tunnel-key";
/** bcrypt rounds for the encrypted test key; OpenSSH uses 16, a test needs only a few. */
const KEY_ROUNDS = 4;

export interface TestSshServer {
  readonly port: number;
  /** The server's host key blob, as the client is offered it. */
  readonly hostKey: Buffer;
  /** An unencrypted and an encrypted private key the server accepts for `SSH_USER`. */
  readonly plainKey: string;
  readonly encryptedKey: string;
  /** Drops every client connection, as a restarted bastion would. */
  dropClients(): void;
  /** Forwards to these ports are refused, as a bastion that cannot reach the database refuses them. */
  readonly refusedPorts: Set<number>;
  close(): Promise<void>;
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ssh2 drops a leading zero byte of an ed25519 public key when it writes it, so about one key in
 * 128 comes back "Malformed OpenSSH public key" from its own `parseKey`; draw again until it reads.
 */
function readableKeyPair(encryption?: { passphrase: string; cipher: string; rounds: number }): {
  private: string;
  public: string;
} {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519", encryption);
    const readable =
      !(ssh2.utils.parseKey(pair.public) instanceof Error) &&
      !(ssh2.utils.parseKey(pair.private, encryption?.passphrase) instanceof Error);
    if (readable) return pair;
  }
}

export async function startSshServer(): Promise<TestSshServer> {
  const host = readableKeyPair();
  const plain = readableKeyPair();
  const encrypted = readableKeyPair({
    passphrase: KEY_PASSPHRASE,
    cipher: "aes256-ctr",
    rounds: KEY_ROUNDS,
  });
  const allowed = [plain.public, encrypted.public].map((text) => {
    const parsed = ssh2.utils.parseKey(text);
    if (parsed instanceof Error) throw parsed;
    return parsed;
  });
  const hostKey = ssh2.utils.parseKey(host.public);
  if (hostKey instanceof Error) throw hostKey;
  const clients = new Set<Connection>();
  const refusedPorts = new Set<number>();

  const server = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.username !== SSH_USER) return context.reject();
      if (context.method === "password") {
        return context.password === SSH_PASSWORD ? context.accept() : context.reject();
      }
      if (context.method === "publickey") {
        const key = allowed.find(
          (candidate) => candidate.type === context.key.algo && same(candidate.getPublicSSH(), context.key.data),
        );
        if (key === undefined) return context.reject();
        if (context.signature === undefined) return context.accept();
        return key.verify(context.blob ?? Buffer.alloc(0), context.signature, context.hashAlgo) === true
          ? context.accept()
          : context.reject();
      }
      return context.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        if (refusedPorts.has(info.destPort)) return reject();
        const socket = connect(info.destPort, info.destIP);
        socket.once("error", () => reject());
        socket.once("connect", () => {
          const channel = accept();
          channel.on("error", () => socket.destroy());
          socket.on("error", () => channel.close());
          channel.pipe(socket).pipe(channel);
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hostKey: hostKey.getPublicSSH(),
    plainKey: plain.private,
    encryptedKey: encrypted.private,
    refusedPorts,
    dropClients() {
      for (const client of clients) client.end();
    },
    close() {
      for (const client of clients) client.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A TCP server that echoes every byte, standing in for a database. */
export async function startEchoServer(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Sends `text` to `port` and resolves with the first answer. */
export function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before answering")));
    socket.once("data", (data) => {
      socket.removeAllListeners("close");
      socket.destroy();
      resolve(data.toString("utf8"));
    });
    socket.write(text);
  });
}

/** A loopback port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
