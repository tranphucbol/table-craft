import { describe, expect, it, vi } from "vitest";
import { createConnector, type LoadedPlugin, type Tunnel } from "@table-craft/core";
import type { ConnectOptions, Session } from "@table-craft/plugin-api";
import etcd from "@table-craft/plugin-etcd";
import { ETCD_MANIFEST } from "../support/manifests.js";

function fixture(failAt = -1) {
  const tunnels: { port: number; closed: boolean }[] = [];
  const targets: string[] = [];
  const connectOptions: ConnectOptions[] = [];
  const connect = vi.fn(async (_config: unknown, options: ConnectOptions) => {
    await Promise.resolve();
    connectOptions.push(options);
    return { serverVersion: null, close: async () => {} } as unknown as Session;
  });
  const loaded: LoadedPlugin = {
    status: "loaded",
    directory: "plugins/etcd",
    manifest: ETCD_MANIFEST,
    plugin: {
      ...etcd,
      connect,
      connectionEndpoints: () => [
        { id: "a", host: "one", port: 2379 },
        { id: "b", host: "two", port: 2379 },
      ],
    },
  };
  const connector = createConnector({
    plugins: [loaded],
    pluginId: "etcd",
    config: {},
    ssh: { host: "bastion", port: 22, user: "tunnel", auth: "agent" },
    verifyHostKey: async () => {},
    openTunnel: async ({ target }) => {
      await Promise.resolve();
      targets.push(target.host);
      if (targets.length - 1 === failAt) throw new Error("tunnel refused");
      const state = { port: 40000 + tunnels.length, closed: false };
      tunnels.push(state);
      const listeners: ((reason: string | null) => void)[] = [];
      const tunnel: Tunnel = {
        localPort: state.port,
        forwardError: null,
        onClose: (listener) => {
          listeners.push(listener);
        },
        close: async () => {
          await Promise.resolve();
          state.closed = true;
          for (const listener of listeners) listener(null);
        },
      };
      return tunnel;
    },
  });
  return { connector, tunnels, targets, connectOptions, connect };
}

describe("multi-endpoint SSH connector", () => {
  it("givenTwoEndpointsAndSessions_whenClosed_thenOneSharedTunnelEachAndAllReleased", async () => {
    const fixtureData = fixture();
    const first = await fixtureData.connector.connect({ readOnly: true });
    const second = await fixtureData.connector.connect({ readOnly: true });
    expect(fixtureData.targets).toEqual(["one", "two"]);
    expect(fixtureData.connectOptions[0]?.transports).toEqual([
      { id: "a", host: "127.0.0.1", port: 40000, serverName: "one" },
      { id: "b", host: "127.0.0.1", port: 40001, serverName: "two" },
    ]);
    await first.close();
    expect(fixtureData.tunnels.every((tunnel) => !tunnel.closed)).toBe(true);
    await second.close();
    expect(fixtureData.tunnels.every((tunnel) => tunnel.closed)).toBe(true);
  });

  it("givenPartialAcquisitionFailure_whenConnectFails_thenAllAcquiredLeasesReleased", async () => {
    const fixtureData = fixture(1);
    await expect(fixtureData.connector.connect({ readOnly: true })).rejects.toThrow("tunnel refused");
    expect(fixtureData.connect).not.toHaveBeenCalled();
    expect(fixtureData.tunnels.every((tunnel) => tunnel.closed)).toBe(true);
  });

  it("givenPluginConnectFailure_whenConnectFails_thenEveryTunnelReleased", async () => {
    const fixtureData = fixture();
    fixtureData.connect.mockRejectedValueOnce(new Error("cluster mismatch"));
    await expect(fixtureData.connector.connect({ readOnly: true })).rejects.toThrow("cluster mismatch");
    expect(fixtureData.tunnels).toHaveLength(2);
    expect(fixtureData.tunnels.every((tunnel) => tunnel.closed)).toBe(true);
  });
});
