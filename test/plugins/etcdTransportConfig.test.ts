import { afterEach, describe, expect, it, vi } from "vitest";
import { EtcdClient } from "@table-craft/plugin-etcd/client";
import { connectionSchema, connectionEndpoints, namespaceBytes } from "@table-craft/plugin-etcd/config";
import { openConnection } from "@table-craft/plugin-etcd/connect";

afterEach(() => vi.restoreAllMocks());

describe("etcd advanced transport config", () => {
  it("givenLegacyConfig_whenParsed_thenSingleStableEndpointAndSafeDefaults", () => {
    const config = connectionSchema.parse({ host: "legacy", port: 2379 });
    expect(connectionEndpoints(config)).toEqual([{ id: "primary", host: "legacy", port: 2379 }]);
    expect(config.readMode).toBe("linearizable");
    expect(config.autoSyncInterval).toBe(0);
  });

  it("givenExplicitEndpoints_whenParsed_thenListReplacesLegacyAndPreservesIpv6", () => {
    const config = connectionSchema.parse({ endpoints: "one:2379, [::1]:2380" });
    expect(connectionEndpoints(config)).toEqual([
      { id: "endpoint-1", host: "one", port: 2379 },
      { id: "endpoint-2", host: "::1", port: 2380 },
    ]);
    for (const endpoints of ["http://one:2379", "one:0", "one:65536", "one:2379,one:2379", "one:2379,"]) {
      expect(connectionSchema.safeParse({ endpoints }).success).toBe(false);
    }
  });

  it("givenBinaryNamespace_whenDecoded_thenExactBytesAndNoncanonicalRejected", () => {
    const bytes = Buffer.from([0, 255, 47, 128]);
    expect(
      namespaceBytes(connectionSchema.parse({ namespace: bytes.toString("base64"), namespaceEncoding: "base64" })),
    ).toEqual(bytes);
    expect(connectionSchema.safeParse({ namespace: "//", namespaceEncoding: "base64" }).success).toBe(false);
  });

  it("givenClientCnWithoutCertificate_whenParsed_thenRejected", () => {
    expect(connectionSchema.safeParse({ authMode: "clientCN" }).success).toBe(false);
  });

  it("givenIncompleteAuthoritativeTransports_whenConnecting_thenNoNetworkCall", async () => {
    const calls = vi.spyOn(EtcdClient.prototype, "call");
    await expect(
      openConnection(connectionSchema.parse({ endpoints: "one:2379,two:2379" }), {
        readOnly: true,
        transports: [{ id: "endpoint-1", host: "127.0.0.1", port: 40001, serverName: "one" }],
      }),
    ).rejects.toThrow("every configured");
    expect(calls).not.toHaveBeenCalled();
  });

  it("givenMismatchedClusters_whenProbed_thenPoolNeverAdmitted", async () => {
    vi.spyOn(EtcdClient.prototype, "call")
      .mockResolvedValueOnce({ id: "1", version: "3.6.0" })
      .mockResolvedValueOnce({ id: "2", version: "3.6.0" });
    await expect(
      openConnection(connectionSchema.parse({ endpoints: "one:2379,two:2379" }), { readOnly: true }),
    ).rejects.toThrow("different clusters");
  });

  it("givenUnreachableConfiguredMember_whenConnecting_thenHealthReportsAndPoolExcludesIt", async () => {
    vi.spyOn(EtcdClient.prototype, "call")
      .mockResolvedValueOnce({ id: "1", version: "3.6.0" })
      .mockRejectedValueOnce(new Error("unreachable"));
    const connection = await openConnection(connectionSchema.parse({ endpoints: "one:2379,two:2379" }), {
      readOnly: true,
    });
    try {
      expect(connection.endpoints).toEqual([
        { id: "endpoint-1", reachable: true },
        { id: "endpoint-2", reachable: false },
      ]);
      expect(connection.client.endpoints.map((endpoint) => endpoint.id)).toEqual(["endpoint-1"]);
      expect(() => connection.client.pinned("endpoint-2")).toThrow("reachable configured");
    } finally {
      connection.client.close();
    }
  });
});
