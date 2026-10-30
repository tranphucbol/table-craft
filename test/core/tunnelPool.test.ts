import { describe, expect, it } from "vitest";
import { PluginError, isPluginError, type Session } from "@table-craft/plugin-api";
import { TunnelError, createTunnelPool, tunneledSession, type Tunnel } from "@table-craft/core";

interface FakeTunnel extends Tunnel {
  closed: boolean;
  drop(reason: string): void;
}

function fakeTunnel(localPort: number): FakeTunnel {
  const listeners: ((reason: string | null) => void)[] = [];
  const tunnel: FakeTunnel = {
    localPort,
    forwardError: null,
    closed: false,
    close() {
      if (!tunnel.closed) {
        tunnel.closed = true;
        for (const listener of listeners) listener(null);
      }
      return Promise.resolve();
    },
    onClose(listener) {
      listeners.push(listener);
    },
    drop(reason) {
      tunnel.closed = true;
      for (const listener of listeners) listener(reason);
    },
  };
  return tunnel;
}

function opener(): { readonly tunnels: FakeTunnel[]; readonly open: () => Promise<Tunnel> } {
  const tunnels: FakeTunnel[] = [];
  return {
    tunnels,
    open: () => {
      const tunnel = fakeTunnel(40_000 + tunnels.length);
      tunnels.push(tunnel);
      return Promise.resolve(tunnel);
    },
  };
}

describe("createTunnelPool", () => {
  it("givenTwoSessions_whenOneCloses_thenTunnelStaysOpen", async () => {
    const source = opener();
    const pool = createTunnelPool(source.open);
    const first = await pool.acquire();
    const second = await pool.acquire();

    first.release();

    expect(source.tunnels).toHaveLength(1);
    expect(second.localPort).toBe(first.localPort);
    expect(source.tunnels[0]?.closed).toBe(false);
  });

  it("givenLastSessionClosed_whenTunnelRefcountZero_thenTunnelCloses", async () => {
    const source = opener();
    const pool = createTunnelPool(source.open);
    const first = await pool.acquire();
    const second = await pool.acquire();

    first.release();
    first.release();
    second.release();

    expect(source.tunnels[0]?.closed).toBe(true);
    await pool.acquire();
    expect(source.tunnels).toHaveLength(2);
  });

  it("givenConcurrentAcquire_whenOpening_thenOneTunnel", async () => {
    const source = opener();
    const pool = createTunnelPool(source.open);

    await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);

    expect(source.tunnels).toHaveLength(1);
  });

  it("givenTunnelDropped_whenAcquiredAgain_thenNewTunnelAndOldLeasesLost", async () => {
    const source = opener();
    const pool = createTunnelPool(source.open);
    const lease = await pool.acquire();

    source.tunnels[0]?.drop("connection reset");
    const next = await pool.acquire();

    expect(lease.lost).toBe("connection reset");
    expect(next.lost).toBeNull();
    expect(source.tunnels).toHaveLength(2);
  });

  it("givenOpenFails_whenAcquiredAgain_thenRetries", async () => {
    let attempts = 0;
    const pool = createTunnelPool(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("refused")) : Promise.resolve(fakeTunnel(1));
    });

    await expect(pool.acquire()).rejects.toThrow("refused");
    await expect(pool.acquire()).resolves.toMatchObject({ localPort: 1 });
  });

  it("givenPoolClosed_whenAcquired_thenRefusedAndTunnelClosed", async () => {
    const source = opener();
    const pool = createTunnelPool(source.open);
    await pool.acquire();

    await pool.close();

    expect(source.tunnels[0]?.closed).toBe(true);
    await expect(pool.acquire()).rejects.toBeInstanceOf(TunnelError);
  });
});

function fakeSession(execute: () => Promise<unknown>): Session & { closes: number } {
  const session = {
    closes: 0,
    serverVersion: "17",
    execute,
    transactions: {
      mode: "auto" as const,
      open: false,
      setMode: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    },
    close() {
      session.closes += 1;
      return Promise.resolve();
    },
  };
  return session as unknown as Session & { closes: number };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

describe("tunneledSession", () => {
  it("givenSessionClosedTwice_whenClosed_thenLeaseReleasedOnce", async () => {
    const source = opener();
    const pool = createTunnelPool(source.open);
    const lease = await pool.acquire();
    const other = await pool.acquire();
    const inner = fakeSession(() => Promise.resolve());
    const session = tunneledSession(inner, lease, "bastion:22");

    await session.close();
    await session.close();

    expect(inner.closes).toBe(1);
    expect(source.tunnels[0]?.closed).toBe(false);
    other.release();
    expect(source.tunnels[0]?.closed).toBe(true);
  });

  it("givenTunnelDropped_whenSessionCalled_thenConnectionLostUnsent", async () => {
    const source = opener();
    const lease = await createTunnelPool(source.open).acquire();
    let calls = 0;
    const session = tunneledSession(
      fakeSession(() => {
        calls += 1;
        return Promise.resolve();
      }),
      lease,
      "bastion:22",
    );

    source.tunnels[0]?.drop("connection reset");
    const error = await rejection(session.execute("select 1"));
    const nested = await rejection(session.transactions?.setMode("manual") ?? Promise.resolve());

    expect(calls).toBe(0);
    expect(isPluginError(error) && error.code).toBe("connectionLost");
    expect(isPluginError(nested) && nested.code).toBe("connectionLost");
    expect((error as Error).message).toContain("bastion:22");
  });

  it("givenTunnelDroppedMidStatement_whenRejects_thenSshTunnelLost", async () => {
    const source = opener();
    const lease = await createTunnelPool(source.open).acquire();
    const session = tunneledSession(
      fakeSession(() => {
        source.tunnels[0]?.drop("connection reset");
        return Promise.reject(new PluginError("statementFailed", "Connection terminated unexpectedly"));
      }),
      lease,
      "bastion:22",
    );

    const error = await rejection(session.execute("update t set a = 1"));

    expect(error).toBeInstanceOf(TunnelError);
    expect((error as TunnelError).code).toBe("sshTunnelLost");
  });

  it("givenTunnelOpen_whenStatementFails_thenErrorPassesThrough", async () => {
    const lease = await createTunnelPool(opener().open).acquire();
    const failure = new PluginError("statementFailed", "syntax error");
    const session = tunneledSession(
      fakeSession(() => Promise.reject(failure)),
      lease,
      "bastion:22",
    );

    expect(await rejection(session.execute("selec"))).toBe(failure);
    expect(session.serverVersion).toBe("17");
    expect(session.transactions?.open).toBe(false);
  });

  it("givenDriverSaysConnectionLostAfterSend_whenTunnelDrops_thenNeverDefinitelyUnsent", async () => {
    const source = opener();
    const lease = await createTunnelPool(source.open).acquire();
    const session = tunneledSession(
      fakeSession(async () => {
        await Promise.resolve();
        source.tunnels[0]?.drop("reset after send");
        throw new PluginError("connectionLost", "socket closed");
      }),
      lease,
      "bastion",
    );
    const error = await rejection(session.execute("put /key value"));
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as TunnelError).code).toBe("sshTunnelLost");
  });

  it("givenNestedWatchResource_whenSessionCloses_thenResourceClosesBeforeTunnelRelease", async () => {
    const source = opener();
    const lease = await createTunnelPool(source.open).acquire();
    const closed: boolean[] = [];
    const inner = fakeSession(() => Promise.resolve(undefined));
    const handle = {
      next: () => Promise.resolve({ events: [], state: "live" as const, completedRevision: null, gap: null }),
      close: async () => {
        await Promise.resolve();
        closed.push(source.tunnels[0]!.closed);
      },
    };
    const session = tunneledSession({ ...inner, watch: { open: () => Promise.resolve(handle) } }, lease, "bastion");
    const watch = await session.watch!.open({ database: 0, range: { kind: "all" }, from: { kind: "now" } });
    expect(watch).not.toBe(handle);
    await session.close();
    expect(closed).toEqual([false]);
    expect(source.tunnels[0]?.closed).toBe(true);
    await expect(watch.next({ count: 1, maxBytes: 100, timeoutMs: 1 })).rejects.toMatchObject({
      code: "connectionLost",
    });
  });
});
