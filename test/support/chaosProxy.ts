import { createServer, connect, type Server, type Socket } from "node:net";

const LOOPBACK = "127.0.0.1";
const MS_PER_SECOND = 1_000;
/** How often a throttled link releases its next slice; small enough that the rate looks smooth. */
const THROTTLE_TICK_MS = 20;

/** The link between a client and a database, shaped by a test (plan 018's chaos harness). */
export interface ChaosProxy {
  /** Loopback, whatever host the target is on; a test points its datasource here. */
  readonly host: string;
  readonly port: number;
  /** Sockets currently open from clients through the proxy. */
  readonly openLinks: number;
  /** Added before every chunk forwarded in either direction. */
  latencyMs: number;
  /** Caps each direction of each link; `0` means unthrottled. */
  bytesPerSecond: number;
  /** Holds every byte in both directions, keeping the sockets open: a network that went quiet. */
  stall(): void;
  /** Releases what `stall` held and forwards again. */
  resume(): void;
  /** Sends a TCP reset on every open link, as a dropped connection or a restarted server does. */
  reset(): void;
  /** Drops every byte in both directions from now on and never closes: a route that vanished. */
  blackhole(): void;
  /** Blackholes only the links open now; new ones still pass: one connection's route vanished. */
  strand(): void;
  close(): Promise<void>;
}

interface Pipe {
  readonly to: Socket;
  readonly queue: Buffer[];
  flushing: boolean;
  stranded: boolean;
}

/** Starts a proxy on a free loopback port that forwards to `target`. */
export async function chaosProxy(target: { readonly host: string; readonly port: number }): Promise<ChaosProxy> {
  const links = new Set<Socket>();
  const clients = new Set<Socket>();
  const pipes = new Set<Pipe>();
  let stalled = false;
  let dropping = false;

  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function flush(pipe: Pipe): Promise<void> {
    if (pipe.flushing) return;
    pipe.flushing = true;
    try {
      while (!stalled && pipe.queue.length > 0 && !pipe.to.destroyed) {
        if (proxy.latencyMs > 0) await pause(proxy.latencyMs);
        let chunk = pipe.queue.shift() as Buffer;
        if (proxy.bytesPerSecond > 0) {
          const slice = Math.max(1, Math.floor((proxy.bytesPerSecond * THROTTLE_TICK_MS) / MS_PER_SECOND));
          if (chunk.length > slice) {
            pipe.queue.unshift(chunk.subarray(slice));
            chunk = chunk.subarray(0, slice);
          }
          await pause(THROTTLE_TICK_MS);
        }
        if (stalled) {
          pipe.queue.unshift(chunk);
          break;
        }
        if (dropping || pipe.stranded || pipe.to.destroyed) continue;
        if (!pipe.to.write(chunk)) await new Promise<void>((resolve) => pipe.to.once("drain", resolve));
      }
    } finally {
      pipe.flushing = false;
    }
  }

  function forward(from: Socket, to: Socket): void {
    const pipe: Pipe = { to, queue: [], flushing: false, stranded: false };
    pipes.add(pipe);
    from.on("data", (chunk: Buffer) => {
      if (dropping || pipe.stranded) return;
      pipe.queue.push(chunk);
      void flush(pipe);
    });
    from.on("close", () => pipes.delete(pipe));
  }

  const server: Server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    links.add(client);
    clients.add(client);
    for (const socket of [client, upstream]) socket.on("error", () => undefined);
    client.on("close", () => {
      links.delete(client);
      clients.delete(client);
      if (!dropping) upstream.destroy();
    });
    upstream.on("close", () => {
      if (!dropping) client.destroy();
    });
    forward(client, upstream);
    forward(upstream, client);
    links.add(upstream);
    upstream.on("close", () => links.delete(upstream));
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The chaos proxy has no TCP port.");

  const proxy: ChaosProxy = {
    host: LOOPBACK,
    port: address.port,
    get openLinks() {
      return clients.size;
    },
    latencyMs: 0,
    bytesPerSecond: 0,
    stall() {
      stalled = true;
    },
    resume() {
      stalled = false;
      for (const pipe of pipes) void flush(pipe);
    },
    reset() {
      for (const socket of links) socket.resetAndDestroy();
    },
    blackhole() {
      dropping = true;
      for (const pipe of pipes) pipe.queue.length = 0;
    },
    strand() {
      for (const pipe of pipes) {
        pipe.stranded = true;
        pipe.queue.length = 0;
      }
    },
    async close() {
      for (const socket of links) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return proxy;
}
