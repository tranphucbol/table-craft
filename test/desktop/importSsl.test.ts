import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapConnection } from "@table-craft/desktop/main/import/mapping.js";
import type { ForeignConnection, ForeignSsl } from "@table-craft/desktop/main/import/types.js";
import { listPlugins } from "@table-craft/desktop/main/plugins.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";

const BUILT_IN_PLUGINS = join(import.meta.dirname, "../../plugins");
const NO_FILES = { caFile: null, certFile: null, keyFile: null };

function connection(ssl: ForeignSsl): ForeignConnection {
  return {
    app: "datagrip",
    id: "c1",
    name: "Secure PG",
    folder: null,
    driver: "postgresql",
    url: "jdbc:postgresql://db.example.com:5432/app",
    host: null,
    port: null,
    database: null,
    user: "app",
    path: null,
    ssh: null,
    ssl,
    color: null,
    comment: "",
    readOnly: false,
    password: { kind: "none" },
  };
}

async function mapped(ssl: ForeignSsl, plugins?: readonly PluginInfo[]) {
  const context = {
    plugins: plugins ?? (await listPlugins([BUILT_IN_PLUGINS])),
    existing: [],
    availability: () => "none" as const,
  };
  return mapConnection(connection(ssl), context);
}

describe("importing SSL settings", () => {
  it("givenVerifyCaWithFiles_whenMapped_thenModeAndPathsCarriedWithoutWarnings", async () => {
    const result = await mapped({
      mode: "verifyCa",
      caFile: "/certs/ca.pem",
      certFile: "/certs/client.crt",
      keyFile: "/certs/client.key",
    });

    expect(result.draft?.config).toMatchObject({
      sslMode: "verify-ca",
      sslRootCert: "/certs/ca.pem",
      sslCert: "/certs/client.crt",
      sslKey: "/certs/client.key",
    });
    expect(result.row.warnings).toEqual([]);
  });

  it("givenVerifyIdentity_whenMapped_thenVerifyFull", async () => {
    const result = await mapped({ mode: "verifyIdentity", ...NO_FILES, caFile: "/certs/ca.pem" });

    expect(result.draft?.config).toMatchObject({ sslMode: "verify-full", sslRootCert: "/certs/ca.pem" });
  });

  it("givenPluginWithoutCertificateFields_whenMapped_thenFilesDroppedWithWarning", async () => {
    const plugins = (await listPlugins([BUILT_IN_PLUGINS])).map((plugin) =>
      plugin.id === "postgres" ? { ...plugin, tls: null } : plugin,
    );

    const result = await mapped({ mode: "required", ...NO_FILES, keyFile: "/certs/client.key" }, plugins);

    expect(result.draft?.config).not.toHaveProperty("sslKey", "/certs/client.key");
    expect(result.row.warnings).toEqual([expect.stringContaining("certificate files were not imported")]);
  });
});
