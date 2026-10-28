import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectionUrlError,
  formatConnectionUrl,
  parseConnectionUrl,
  pluginManifestSchema,
  type PluginManifest,
} from "@table-craft/plugin-api";

const PLUGINS = resolve(import.meta.dirname, "../../plugins");

function manifest(id: string): PluginManifest {
  return pluginManifestSchema.parse(JSON.parse(readFileSync(join(PLUGINS, id, "table-craft-plugin.json"), "utf8")));
}

const POSTGRES = manifest("postgres");
const MYSQL = manifest("mysql");
const SQLITE = manifest("sqlite");
const MSSQL = manifest("mssql");

describe("parseConnectionUrl", () => {
  it("givenFullPostgresUrl_whenParsed_thenFillsFieldsAndKeepsPasswordApart", () => {
    const parsed = parseConnectionUrl(
      POSTGRES,
      "postgresql://alice:s%40cret@db.example.com:6543/sales?sslmode=require&application_name=etl&connect_timeout=5",
    );

    expect(parsed).toEqual({
      values: {
        host: "db.example.com",
        port: 6543,
        database: "sales",
        user: "alice",
        sslMode: "require",
        applicationName: "etl",
        connectTimeout: 5,
      },
      secrets: { password: "s@cret" },
      ignored: [],
    });
  });

  it("givenPostgresAliasesAndUnknownParams_whenParsed_thenMapsLibpqNamesAndListsTheRest", () => {
    const parsed = parseConnectionUrl(
      POSTGRES,
      "jdbc:postgres://localhost?dbname=app&user=bob&sslmode=prefer&target_session_attrs=any",
    );

    expect(parsed.values).toEqual({ host: "localhost", database: "app", user: "bob" });
    expect(parsed.secrets).toEqual({});
    expect(parsed.ignored).toEqual(["sslmode=prefer", "target_session_attrs"]);
  });

  it("givenIpv6Host_whenParsed_thenDropsBrackets", () => {
    expect(parseConnectionUrl(POSTGRES, "postgres://[::1]:5433/x").values).toEqual({
      host: "::1",
      port: 5433,
      database: "x",
    });
  });

  it("givenMysqlSslModeInAnyCase_whenParsed_thenMapsToTheFormsChoice", () => {
    expect(parseConnectionUrl(MYSQL, "mysql://root@127.0.0.1:3306/shop?ssl-mode=required").values).toEqual({
      host: "127.0.0.1",
      port: 3306,
      database: "shop",
      user: "root",
      sslMode: "require",
    });
    expect(parseConnectionUrl(MYSQL, "mariadb://h/?ssl-mode=VERIFY_IDENTITY").values.sslMode).toBe("verify-full");
    expect(parseConnectionUrl(MYSQL, "mysql://h?ssl-mode=PREFERRED").ignored).toEqual(["ssl-mode=PREFERRED"]);
  });

  it("givenWrongScheme_whenParsed_thenSaysWhatItExpected", () => {
    expect(() => parseConnectionUrl(POSTGRES, "mysql://h/db")).toThrow(
      new ConnectionUrlError("Expected a URL starting with postgresql:// or postgres://."),
    );
    expect(() => parseConnectionUrl(MYSQL, "localhost:3306")).toThrow(ConnectionUrlError);
    expect(() => parseConnectionUrl(MYSQL, "   ")).toThrow(ConnectionUrlError);
  });

  it("givenPortThatIsNotANumber_whenParsed_thenRejects", () => {
    expect(() => parseConnectionUrl(POSTGRES, "postgres://h:abc/db")).toThrow(ConnectionUrlError);
  });

  it("givenSqliteForms_whenParsed_thenReadsThePath", () => {
    const path = (text: string) => parseConnectionUrl(SQLITE, text).values.path;

    expect(path("/var/data/app.db")).toBe("/var/data/app.db");
    expect(path(":memory:")).toBe(":memory:");
    expect(path("sqlite:///var/data/my%20app.db")).toBe("/var/data/my app.db");
    expect(path("file:///var/data/app.db?mode=ro")).toBe("/var/data/app.db");
    expect(path("file://localhost/var/data/app.db")).toBe("/var/data/app.db");
    expect(path("sqlite::memory:")).toBe(":memory:");
    expect(path("sqlite:relative.db")).toBe("relative.db");
    expect(path("C:\\data\\app.db")).toBe("C:\\data\\app.db");
    expect(path("file:///C:/data/app.db")).toBe("C:/data/app.db");
    expect(parseConnectionUrl(SQLITE, "file:///a.db?mode=ro").ignored).toEqual(["mode"]);
  });

  it("givenRemoteFileUrl_whenParsed_thenRejects", () => {
    expect(() => parseConnectionUrl(SQLITE, "file://server/share/app.db")).toThrow(ConnectionUrlError);
    expect(() => parseConnectionUrl(SQLITE, "postgres://h/db")).toThrow(
      new ConnectionUrlError("Expected a file path, or a URL starting with sqlite: or file:."),
    );
  });

  it("givenUrlWithSslrootcert_whenPasted_thenFieldsFilled", () => {
    const parsed = parseConnectionUrl(
      POSTGRES,
      "postgresql://h/db?sslmode=verify-ca&sslrootcert=%2Fcerts%2Fca.pem&sslcert=~/c.crt&sslkey=~/c.key",
    );

    expect(parsed.values).toMatchObject({
      sslMode: "verify-ca",
      sslRootCert: "/certs/ca.pem",
      sslCert: "~/c.crt",
      sslKey: "~/c.key",
    });
    expect(parsed.ignored).toEqual([]);
  });

  it("givenMysqlUrlWithSslCa_whenPasted_thenFieldsFilled", () => {
    const parsed = parseConnectionUrl(MYSQL, "mysql://h/db?ssl-mode=VERIFY_CA&ssl-ca=/certs/ca.pem&ssl-key=/c.key");

    expect(parsed.values).toMatchObject({ sslMode: "verify-ca", sslRootCert: "/certs/ca.pem", sslKey: "/c.key" });
  });

  it("givenManifestWithoutUrl_whenParsed_thenRejects", () => {
    const { url: _url, ...connection } = SQLITE.connection;
    expect(() => parseConnectionUrl({ connection }, "/a.db")).toThrow("This data source type has no connection URL.");
  });
});

describe("formatConnectionUrl", () => {
  it("givenPostgresConfig_whenFormatted_thenOmitsPasswordAndDefaultParams", () => {
    const config = {
      host: "db.example.com",
      port: 6543,
      database: "sales",
      user: "alice",
      password: "never",
      sslMode: "require",
      connectTimeout: 10,
      applicationName: "TableCraft",
    };

    expect(formatConnectionUrl(POSTGRES, config)).toBe("postgresql://alice@db.example.com:6543/sales?sslmode=require");
  });

  it("givenFormattedUrl_whenParsedBack_thenSameFields", () => {
    const config = { host: "::1", port: 3307, database: "a b", user: "x@y", sslMode: "verify-full" };
    const url = formatConnectionUrl(MYSQL, config);

    expect(url).toBe("mysql://x%40y@[::1]:3307/a%20b?ssl-mode=VERIFY_IDENTITY");
    expect(parseConnectionUrl(MYSQL, url).values).toEqual(config);
  });

  it("givenCertificatePaths_whenFormatted_thenCarriedAndBlankOnesOmitted", () => {
    const config = {
      host: "h",
      user: "u",
      sslMode: "verify-full",
      sslRootCert: "/certs/ca.pem",
      sslCert: "",
      sslKey: "",
    };

    expect(formatConnectionUrl(POSTGRES, config)).toBe(
      "postgresql://u@h?sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem",
    );
  });

  it("givenSqlitePaths_whenFormatted_thenRoundTrips", () => {
    for (const path of ["/var/data/my app.db", ":memory:", "relative.db", "/tmp/a#b?.db"]) {
      const url = formatConnectionUrl(SQLITE, { path });
      expect(url.startsWith("sqlite:")).toBe(true);
      expect(parseConnectionUrl(SQLITE, url).values.path).toBe(path);
    }
  });
});

describe("connection url sets", () => {
  const KEY_VALUE = pluginManifestSchema.parse({
    id: "kv",
    name: "Key value",
    version: "1.0.0",
    apiVersion: "1.2.0",
    entry: "index.js",
    capabilities: ["commands"],
    highlight: "redis",
    connection: {
      fields: [
        { key: "host", label: "Host", kind: "text", required: true },
        { key: "port", label: "Port", kind: "number" },
        { key: "user", label: "User", kind: "text" },
        { key: "password", label: "Password", kind: "password", secret: true },
        {
          key: "tlsMode",
          label: "TLS",
          kind: "select",
          default: "disable",
          options: [
            { value: "disable", label: "Disable" },
            { value: "require", label: "Require" },
          ],
        },
      ],
      url: {
        schemes: ["redis", "rediss"],
        form: "server",
        parts: { host: "host", port: "port", user: "user", password: "password" },
        sets: { rediss: { tlsMode: "require" } },
      },
    },
  });

  it("givenSecureScheme_whenParsed_thenSetsTheFieldsItImplies", () => {
    expect(parseConnectionUrl(KEY_VALUE, "rediss://cache.example.com:6380").values).toEqual({
      host: "cache.example.com",
      port: 6380,
      tlsMode: "require",
    });
    expect(parseConnectionUrl(KEY_VALUE, "redis://cache.example.com").values).toEqual({ host: "cache.example.com" });
  });

  it("givenConfigHoldingASchemesValues_whenFormatted_thenThatSchemeIsWritten", () => {
    expect(formatConnectionUrl(KEY_VALUE, { host: "h", tlsMode: "require" })).toBe("rediss://h");
    expect(formatConnectionUrl(KEY_VALUE, { host: "h", tlsMode: "disable" })).toBe("redis://h");
  });
});

describe("semicolon parameters", () => {
  it("givenJdbcUrlWithSemicolonParams_whenParsed_thenFieldsFilled", () => {
    const parsed = parseConnectionUrl(
      MSSQL,
      "jdbc:sqlserver://db.example.com:1533;databaseName=sales;user=alice;password={pa;ss};encrypt=true;trustServerCertificate=true;loginTimeout=5;sendStringParametersAsUnicode=false",
    );

    expect(parsed).toEqual({
      values: {
        host: "db.example.com",
        port: 1533,
        database: "sales",
        user: "alice",
        encrypt: "mandatory",
        trustServerCertificate: true,
        connectTimeout: 5,
      },
      secrets: { password: "pa;ss" },
      ignored: ["sendStringParametersAsUnicode"],
    });
  });

  it("givenNamedInstance_whenParsed_thenInstanceAndNoPort", () => {
    expect(parseConnectionUrl(MSSQL, "sqlserver://sqlhost\\SQLEXPRESS;databaseName=app").values).toEqual({
      host: "sqlhost",
      instance: "SQLEXPRESS",
      database: "app",
    });
  });

  it("givenBadPort_whenParsed_thenSaysSo", () => {
    expect(() => parseConnectionUrl(MSSQL, "sqlserver://h:abc")).toThrow(ConnectionUrlError);
  });

  it("givenSqlServerConfig_whenFormatted_thenSemicolonFormRoundTrips", () => {
    const config = {
      host: "db.example.com",
      port: 1533,
      database: "a;b",
      user: "alice",
      password: "never",
      encrypt: "strict",
      connectTimeout: 10,
    };
    const url = formatConnectionUrl(MSSQL, config);

    expect(url).toBe("sqlserver://db.example.com:1533;databaseName={a;b};user=alice;encrypt=strict");
    const { password: _password, connectTimeout: _timeout, ...written } = config;
    expect(parseConnectionUrl(MSSQL, url).values).toEqual(written);
  });
});
