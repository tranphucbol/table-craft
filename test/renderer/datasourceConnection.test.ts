import { describe, expect, it } from "vitest";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import {
  connectionProblems,
  endpointProblems,
  endpointRows,
  endpointRowsChange,
  endpointTestDrafts,
  offersEndpointConnection,
} from "@table-craft/desktop/renderer/model/datasourceConnection.js";
import {
  applyParsedUrl,
  draftProblems,
  newDraft,
  toSaveRequest,
} from "@table-craft/desktop/renderer/model/datasourceForm.js";
import { POSTGRES_PLUGIN, REDIS_PLUGIN } from "./datasourceViews.js";

const PLUGIN: PluginInfo = {
  ...POSTGRES_PLUGIN,
  id: "endpoint-capable-example",
  fields: [
    ...POSTGRES_PLUGIN.fields.filter((field) => field.key !== "database"),
    { key: "endpoints", label: "Endpoints", kind: "text", default: "" },
    {
      key: "authMode",
      label: "Authentication",
      kind: "select",
      default: "auto",
      options: [
        { value: "auto", label: "Automatic" },
        { value: "none", label: "None" },
        { value: "password", label: "User and password" },
        { value: "clientCN", label: "Client certificate" },
      ],
    },
    { key: "namespace", label: "Key prefix", kind: "text" },
    {
      key: "namespaceEncoding",
      label: "Prefix encoding",
      kind: "select",
      options: [
        { value: "utf8", label: "UTF-8" },
        { value: "base64", label: "Base64" },
      ],
    },
    { key: "serverName", label: "Server name override", kind: "text" },
  ],
};
const blank = () => newDraft("new-0", PLUGIN, [], "untilRestart");

describe("endpoint connection form", () => {
  it("givenEndpointAuthContractWithArbitraryId_whenDetected_thenNoPluginIdBranchAndGenericPluginsUnchanged", () => {
    expect(offersEndpointConnection(PLUGIN)).toBe(true);
    expect(offersEndpointConnection(POSTGRES_PLUGIN)).toBe(false);
    expect(offersEndpointConnection(REDIS_PLUGIN)).toBe(false);
    expect(endpointRows(blank(), PLUGIN)).toEqual(["localhost:5432"]);
  });

  it("givenCommaOrNewlineEndpoints_whenEdited_thenScalarFormatAndIpv6Preserved", () => {
    const draft = { ...blank(), values: { ...blank().values, endpoints: "one:2379,[::1]:2380\nthree:2379" } };
    expect(endpointRows(draft, PLUGIN)).toEqual(["one:2379", "[::1]:2380", "three:2379"]);
    expect(endpointProblems(draft, PLUGIN)).toEqual([]);
    const next = { ...draft, ...endpointRowsChange(draft, PLUGIN, ["https://one:2379", "https://[::1]:2380/"]) };
    expect(next.values).toMatchObject({ endpoints: "one:2379\n[::1]:2380", sslMode: "verify-full" });
    expect(toSaveRequest(next, PLUGIN).datasource.config.endpoints).toBe("one:2379\n[::1]:2380");
  });

  it("givenVerifiedTls_whenHttpsUrlPasted_thenDoesNotDowngradeVerification", () => {
    const draft = { ...blank(), values: { ...blank().values, sslMode: "verify-ca" } };
    expect(endpointRowsChange(draft, PLUGIN, ["https://one:2379"]).values?.sslMode).toBe("verify-ca");
  });

  it("givenMixedHttpSchemes_whenPasted_thenRefusesRatherThanChoosingLastRowsTlsMode", () => {
    const draft = blank();
    const next = { ...draft, ...endpointRowsChange(draft, PLUGIN, ["https://one:2379", "http://two:2379"]) };
    expect(next.values.sslMode).toBe(draft.values.sslMode);
    expect(endpointProblems(next, PLUGIN)).not.toEqual([]);
  });

  it.each([
    "one:0",
    "one:65536",
    "one:2379,",
    "one:2379,ONE:2379",
    "https://user:secret@one:2379",
    "one:2379/path",
    "one:2379?password=secret",
    "one:2379#fragment",
    "::1:2379",
  ])("givenInvalidEndpoint_%s_whenValidated_thenCannotSave", (endpoints) => {
    const draft = { ...blank(), values: { ...blank().values, endpoints } };
    expect(draftProblems(draft, PLUGIN).length).toBeGreaterThan(0);
  });

  it("givenLastEndpointCleared_whenEdited_thenDoesNotSilentlyRestoreLegacyAddress", () => {
    const draft = blank();
    const next = { ...draft, ...endpointRowsChange(draft, PLUGIN, [""]) };
    expect(endpointRows(next, PLUGIN)).toEqual([""]);
    expect(endpointProblems(next, PLUGIN)).not.toEqual([]);
  });

  it.each(["none", "clientCN"])(
    "givenAuthMode_%s_whenSaved_thenNoUsernamePasswordOrPasswordModeSerialized",
    (authMode) => {
      const draft = {
        ...blank(),
        values: { ...blank().values, authMode, user: "old-user" },
        secrets: { ...blank().secrets, password: { action: "set" as const, value: "never-in-config" } },
      };
      const request = toSaveRequest(draft, PLUGIN);
      expect(request.datasource.config).not.toHaveProperty("user");
      expect(request.datasource.config).not.toHaveProperty("password");
      expect(request.datasource.secretModes).not.toHaveProperty("password");
      expect(request.secrets).not.toHaveProperty("password");
      expect(JSON.stringify(request)).not.toContain("never-in-config");
    },
  );

  it("givenPasswordModeWithSshAndBinaryNamespace_whenSaved_thenSecretsRemainWriteOnlyAndTunnelRetained", () => {
    const draft = {
      ...blank(),
      values: {
        ...blank().values,
        endpoints: "one:2379\ntwo:2379",
        authMode: "password",
        namespace: "AP8=",
        namespaceEncoding: "base64",
        serverName: "cluster.internal",
      },
      ssh: { enabled: true, host: "bastion", port: "22", user: "deploy", auth: "password" as const, keyPath: "" },
      secrets: { ...blank().secrets, password: { action: "set" as const, value: "new-secret" } },
    };
    const request = toSaveRequest(draft, PLUGIN);
    expect(request.datasource.config).toMatchObject({
      namespace: "AP8=",
      namespaceEncoding: "base64",
      serverName: "cluster.internal",
    });
    expect(request.datasource.config).not.toHaveProperty("password");
    expect(request.secrets.password).toEqual({ action: "set", value: "new-secret" });
    expect(request.datasource.ssh).toMatchObject({ enabled: true, host: "bastion" });
  });

  it("givenWholeConnectionUrl_whenApplied_thenUpdatesEndpointScalarTlsAndAuthWithoutPersistingPasswordInUrl", () => {
    const draft = { ...blank(), values: { ...blank().values, endpoints: "old:2379", authMode: "none" } };
    const next = applyParsedUrl(
      draft,
      PLUGIN,
      {
        values: { host: "::1", port: 2380, user: "deploy", sslMode: "verify-full" },
        secrets: { password: "secret" },
        ignored: [],
      },
      "https://deploy:secret@[::1]:2380",
    );
    expect(next.values).toMatchObject({ endpoints: "[::1]:2380", sslMode: "verify-full", authMode: "password" });
    expect(next.url).not.toContain("secret");
    expect(next.secrets.password).toEqual({ action: "set", value: "secret" });
  });

  it("givenPerEndpointTests_whenRequestsBuilt_thenUsesStableOrderedIdsAndPreservesSshTlsAndSecretChanges", () => {
    const draft = {
      ...blank(),
      values: {
        ...blank().values,
        endpoints: "one:2379\ntwo:2379",
        sslMode: "verify-full",
        serverName: "cluster.internal",
      },
      ssh: { ...blank().ssh, enabled: true, host: "bastion", user: "deploy" },
    };
    const targets = endpointTestDrafts(draft, PLUGIN);
    expect(targets.map((target) => target.id)).toEqual(["endpoint-1", "endpoint-2"]);
    expect(targets.map((target) => target.draft.values.endpoints)).toEqual(["one:2379", "two:2379"]);
    for (const target of targets) {
      const request = toSaveRequest(target.draft, PLUGIN);
      expect(request.datasource.ssh).toMatchObject({ enabled: true, host: "bastion" });
      expect(request.datasource.config).toMatchObject({ sslMode: "verify-full", serverName: "cluster.internal" });
      expect(target.draft.secrets).toBe(draft.secrets);
    }
  });

  it("givenClientCnWithoutTlsFilesOrNoncanonicalNamespace_whenChecked_thenActionableProblems", () => {
    const draft = {
      ...blank(),
      values: { ...blank().values, authMode: "clientCN", namespaceEncoding: "base64", namespace: "YQ" },
    };
    expect(connectionProblems(draft, PLUGIN)).toEqual(
      expect.arrayContaining([
        "Client-certificate authentication requires TLS.",
        "Choose a client certificate for client-certificate authentication.",
        "Choose a client key for client-certificate authentication.",
        "Key prefix must be canonical Base64.",
      ]),
    );
  });
});
