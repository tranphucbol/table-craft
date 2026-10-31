import { describe, expect, it } from "vitest";
import {
  applyParsedUrl,
  CA_FILE_UNUSED_NOTE,
  caFileNote,
  draftFromView,
  draftProblems,
  duplicateDraft,
  fieldVisible,
  newDraft,
  offersSshTunnel,
  secretPlaceholder,
  sshSecretField,
  tlsFieldsOf,
  toSaveRequest,
  uniqueName,
  withoutPassword,
} from "@table-craft/desktop/renderer/model/datasourceForm.js";
import type { SshSettings } from "@table-craft/desktop/preload/bridge.js";
import { POSTGRES_PLUGIN, REDIS_PLUGIN, SQLITE_PLUGIN, view } from "./datasourceViews.js";

const SAVED = view({
  id: "pg",
  name: "pg",
  folder: "Docker/Main",
  color: "red",
  config: { host: "db", port: 55432, user: "app", sslMode: "require" },
  secretModes: { password: "forever" },
  storedSecrets: ["password"],
});

describe("datasource form", () => {
  it("givenNewPostgresDraft_whenCreated_thenManifestDefaultsAndDefaultSecretMode", () => {
    const draft = newDraft("new-0", POSTGRES_PLUGIN, ["PostgreSQL"], "forever", "Local");

    expect(draft.name).toBe("PostgreSQL (2)");
    expect(draft.values).toEqual({
      host: "localhost",
      port: "5432",
      database: "",
      user: "",
      sslMode: "disable",
      sslRootCert: "",
      sslCert: "",
      sslKey: "",
    });
    expect(draft.secretModes).toEqual({
      password: "forever",
      sslKeyPassphrase: "forever",
      "ssh.password": "forever",
      "ssh.passphrase": "forever",
    });
    expect(draft.folder).toBe("Local");
    expect(draft.dirty).toBe(true);
  });

  it("givenDraft_whenSaveRequestBuilt_thenNumbersParsedAndBlankOptionalFieldsDropped", () => {
    const draft = {
      ...newDraft("new-0", POSTGRES_PLUGIN, [], "never"),
      values: { host: "h", port: "6543", database: "", user: "u", sslMode: "disable" },
    };

    const request = toSaveRequest(draft, POSTGRES_PLUGIN);

    expect(request.datasource.config).toEqual({ host: "h", port: 6543, user: "u", sslMode: "disable" });
    expect(request.datasource.folder).toBeNull();
    expect(request.secrets).toEqual({ password: { action: "keep" } });
  });

  it("givenSavedDatasource_whenEdited_thenSecretBlankMeansKeepAndPlaceholderSaysSaved", () => {
    const draft = draftFromView(SAVED, POSTGRES_PLUGIN);

    expect(draft.values.port).toBe("55432");
    expect(draft.secrets).toMatchObject({ password: { action: "keep" } });
    expect(secretPlaceholder(draft, "password")).toBe("Saved; leave blank to keep");
    expect(toSaveRequest(draft, POSTGRES_PLUGIN).datasource.id).toBe("pg");
  });

  it("givenMissingRequiredAndBadNumber_whenChecked_thenProblemsNameTheFields", () => {
    const draft = { ...draftFromView(SAVED, POSTGRES_PLUGIN), values: { host: "", port: "abc", user: "u" } };

    expect(draftProblems(draft, POSTGRES_PLUGIN)).toEqual(["Host is required.", "Port must be a number."]);
  });

  it("givenClusterMode_whenDrafted_thenDatabaseHiddenAndNotRequired", () => {
    const standalone = newDraft("new-0", REDIS_PLUGIN, [], "never");
    const database = REDIS_PLUGIN.fields.find((field) => field.key === "database");
    const cluster = { ...standalone, values: { ...standalone.values, mode: "cluster", database: "" } };

    expect(database !== undefined && fieldVisible(database, standalone)).toBe(true);
    expect(database !== undefined && fieldVisible(database, cluster)).toBe(false);
    expect(draftProblems({ ...standalone, values: { ...standalone.values, database: "" } }, REDIS_PLUGIN)).toEqual([
      "Database is required.",
    ]);
    expect(draftProblems(cluster, REDIS_PLUGIN)).toEqual([]);
    expect(
      toSaveRequest({ ...cluster, values: { ...cluster.values, database: "3" } }, REDIS_PLUGIN).datasource.config,
    ).toEqual({
      mode: "cluster",
      host: "localhost",
      port: 6379,
    });
  });

  it("givenListRule_whenModeOutsideList_thenFieldDroppedFromSaveRequest", () => {
    const standalone = newDraft("new-0", REDIS_PLUGIN, [], "never");
    const sentinel = { ...standalone, values: { ...standalone.values, mode: "sentinel", database: "2" } };
    const cluster = { ...sentinel, values: { ...sentinel.values, mode: "cluster" } };

    expect(toSaveRequest(sentinel, REDIS_PLUGIN).datasource.config).toEqual({
      mode: "sentinel",
      host: "localhost",
      port: 6379,
      masterName: "mymaster",
      database: 2,
    });
    expect(toSaveRequest(cluster, REDIS_PLUGIN).datasource.config).toEqual({
      mode: "cluster",
      host: "localhost",
      port: 6379,
    });
  });

  it("givenSavedDatasource_whenDuplicated_thenNewIdlessCopyWithoutStoredSecrets", () => {
    const copy = duplicateDraft("new-1", SAVED, POSTGRES_PLUGIN, ["pg", "pg copy"], "forever");

    expect(copy.id).toBeUndefined();
    expect(copy.name).toBe("pg copy (2)");
    expect(copy.storedSecrets).toEqual([]);
    expect(copy.values.host).toBe("db");
  });

  it("givenTakenNames_whenUniqueNameAsked_thenNextFreeSuffix", () => {
    expect(uniqueName("a", [])).toBe("a");
    expect(uniqueName("a", ["a", "a (2)"])).toBe("a (3)");
  });

  it("givenSavedTimeouts_whenDraftRoundTrips_thenSaveRequestCarriesThem", () => {
    const draft = draftFromView({ ...SAVED, keepAliveSeconds: 0, statementTimeoutSeconds: 45 }, POSTGRES_PLUGIN);

    expect(draft.keepAliveSeconds).toBe("0");
    expect(draft.statementTimeoutSeconds).toBe("45");
    expect(toSaveRequest(draft, POSTGRES_PLUGIN).datasource).toMatchObject({
      keepAliveSeconds: 0,
      statementTimeoutSeconds: 45,
    });
  });

  it("givenEnforce_whenSaved_thenStoredOnlyWhenTrue", () => {
    const enforced = draftFromView(
      { ...SAVED, statementTimeoutSeconds: 30, enforceTimeoutOnServer: true },
      POSTGRES_PLUGIN,
    );
    const unticked = { ...enforced, enforceTimeoutOnServer: false };

    expect(enforced.enforceTimeoutOnServer).toBe(true);
    expect(toSaveRequest(enforced, POSTGRES_PLUGIN).datasource).toMatchObject({ enforceTimeoutOnServer: true });
    expect(toSaveRequest(unticked, POSTGRES_PLUGIN).datasource).not.toHaveProperty("enforceTimeoutOnServer");
    expect(newDraft("new-0", POSTGRES_PLUGIN, [], "forever").enforceTimeoutOnServer).toBe(false);
  });

  it("givenShownNamespaces_whenEditedAndSaved_thenKeptAndCopiedByDuplicate", () => {
    const filtered = view({ ...SAVED, shownNamespaces: ["shop", "billing"] });

    const request = toSaveRequest(draftFromView(filtered, POSTGRES_PLUGIN), POSTGRES_PLUGIN);
    const copy = toSaveRequest(duplicateDraft("new-0", filtered, POSTGRES_PLUGIN, [], "forever"), POSTGRES_PLUGIN);

    expect(request.datasource.shownNamespaces).toEqual(["shop", "billing"]);
    expect(copy.datasource.shownNamespaces).toEqual(["shop", "billing"]);
  });

  it("givenNoShownNamespaces_whenSaveRequestBuilt_thenKeyAbsent", () => {
    expect(toSaveRequest(draftFromView(SAVED, POSTGRES_PLUGIN), POSTGRES_PLUGIN).datasource).not.toHaveProperty(
      "shownNamespaces",
    );
    expect(
      toSaveRequest(newDraft("new-0", POSTGRES_PLUGIN, [], "forever"), POSTGRES_PLUGIN).datasource,
    ).not.toHaveProperty("shownNamespaces");
  });

  it("givenBlankTimeouts_whenSaveRequestBuilt_thenKeysAbsent", () => {
    const request = toSaveRequest(draftFromView(SAVED, POSTGRES_PLUGIN), POSTGRES_PLUGIN);

    expect(request.datasource).not.toHaveProperty("keepAliveSeconds");
    expect(request.datasource).not.toHaveProperty("statementTimeoutSeconds");
  });

  it("givenTimeoutsOutOfRange_whenChecked_thenProblems", () => {
    const draft = {
      ...draftFromView(SAVED, POSTGRES_PLUGIN),
      keepAliveSeconds: "9000",
      statementTimeoutSeconds: "1.5",
    };

    expect(draftProblems(draft, POSTGRES_PLUGIN)).toEqual([
      "The keepalive interval must be between 0 and 7,200.",
      "The statement timeout must be a whole number of seconds.",
    ]);
  });

  it("givenParsedUrl_whenApplied_thenFieldsFilledPasswordSetAndHiddenFromUrlRow", () => {
    const draft = draftFromView(SAVED, POSTGRES_PLUGIN);

    const next = applyParsedUrl(
      draft,
      POSTGRES_PLUGIN,
      {
        values: { host: "db.example.com", port: 6543, database: "sales" },
        secrets: { password: "s3cret" },
        ignored: ["target_session_attrs"],
      },
      " postgresql://alice:s3cret@db.example.com:6543/sales?target_session_attrs=any ",
    );

    expect(next.values).toMatchObject({ host: "db.example.com", port: "6543", database: "sales", user: "app" });
    expect(next.secrets).toMatchObject({ password: { action: "set", value: "s3cret" } });
    expect(next.url).toBe("postgresql://alice@db.example.com:6543/sales?target_session_attrs=any");
    expect(next.urlNote).toEqual({ kind: "applied", secrets: ["Password"], ignored: ["target_session_attrs"] });
    expect(next.dirty).toBe(true);
  });

  it("givenPasswordParameter_whenStripped_thenUrlKeepsTheRest", () => {
    expect(withoutPassword("postgresql://h/db?password=x&sslmode=require")).toBe("postgresql://h/db?sslmode=require");
    expect(withoutPassword("postgresql://h/db?sslmode=require&password=x")).toBe("postgresql://h/db?sslmode=require");
    expect(withoutPassword("postgresql://u:p@h/db")).toBe("postgresql://u@h/db");
  });
});

const TUNNEL: SshSettings = {
  enabled: true,
  host: "bastion",
  port: 2204,
  user: "deploy",
  auth: "password",
  keyPath: "",
};

describe("datasource form SSH tunnel", () => {
  it("givenManifestWithoutNetwork_whenDialogRenders_thenNoSshSection", () => {
    const blank = newDraft("new-0", SQLITE_PLUGIN, [], "forever");
    const draft = { ...blank, values: { path: "/tmp/a.db" }, ssh: { ...blank.ssh, enabled: true, host: "h" } };

    expect(offersSshTunnel(SQLITE_PLUGIN)).toBe(false);
    expect(offersSshTunnel(POSTGRES_PLUGIN)).toBe(true);
    expect(draft.secretModes).not.toHaveProperty("ssh.password");
    expect(toSaveRequest(draft, SQLITE_PLUGIN).datasource).not.toHaveProperty("ssh");
    expect(draftProblems(draft, SQLITE_PLUGIN)).toEqual([]);
  });

  it("givenUntouchedSshSection_whenSaveRequestBuilt_thenNoSshAndNoSshSecrets", () => {
    const request = toSaveRequest(newDraft("new-0", POSTGRES_PLUGIN, [], "forever"), POSTGRES_PLUGIN);

    expect(request.datasource).not.toHaveProperty("ssh");
    expect(request.datasource.secretModes).toEqual({ password: "forever" });
    expect(request.secrets).toEqual({ password: { action: "keep" } });
  });

  it("givenSavedTunnel_whenDraftRoundTrips_thenSettingsAndSecretsCarried", () => {
    const saved = {
      ...SAVED,
      ssh: TUNNEL,
      secretModes: { password: "forever" as const, "ssh.password": "never" as const },
    };
    const draft = draftFromView(saved, POSTGRES_PLUGIN);
    const typed = { ...draft, secrets: { ...draft.secrets, "ssh.password": { action: "set" as const, value: "pw" } } };

    const request = toSaveRequest(typed, POSTGRES_PLUGIN);

    expect(draft.ssh).toEqual({ ...TUNNEL, port: "2204" });
    expect(request.datasource.ssh).toEqual(TUNNEL);
    expect(request.datasource.secretModes).toEqual({
      password: "forever",
      "ssh.password": "never",
      "ssh.passphrase": "forever",
    });
    expect(request.secrets["ssh.password"]).toEqual({ action: "set", value: "pw" });
  });

  it("givenBlankSshPort_whenSaveRequestBuilt_thenPort22", () => {
    const draft = { ...newDraft("new-0", POSTGRES_PLUGIN, [], "forever"), ssh: { ...TUNNEL, port: "" } };

    expect(toSaveRequest(draft, POSTGRES_PLUGIN).datasource.ssh?.port).toBe(22);
  });

  it("givenEnabledTunnelMissingFields_whenChecked_thenProblemsNameThem", () => {
    const draft = {
      ...newDraft("new-0", POSTGRES_PLUGIN, [], "forever"),
      values: { host: "db", port: "5432", user: "app" },
      ssh: { enabled: true, host: " ", port: "70000", user: "", auth: "key" as const, keyPath: "" },
    };

    expect(draftProblems(draft, POSTGRES_PLUGIN)).toEqual([
      "SSH host is required.",
      "The SSH port must be a whole number from 1 to 65535.",
      "SSH user is required.",
      "The private key file is required.",
    ]);
    expect(draftProblems({ ...draft, ssh: { ...draft.ssh, enabled: false } }, POSTGRES_PLUGIN)).toEqual([]);
  });

  it("givenAuthMethod_whenSecretFieldAsked_thenPasswordPassphraseOrNone", () => {
    const ssh = { ...newDraft("new-0", POSTGRES_PLUGIN, [], "forever").ssh };

    expect(sshSecretField({ ...ssh, auth: "password" })).toMatchObject({ key: "ssh.password", label: "SSH password" });
    expect(sshSecretField({ ...ssh, auth: "key" })).toMatchObject({ key: "ssh.passphrase", label: "Key passphrase" });
    expect(sshSecretField({ ...ssh, auth: "agent" })).toBeNull();
  });
});

describe("datasource form certificates", () => {
  const blank = newDraft("new-0", POSTGRES_PLUGIN, [], "forever");
  const withValues = (values: Record<string, string>) => ({ ...blank, values: { ...blank.values, ...values } });

  it("givenTlsSpec_whenFieldsListed_thenModeCaCertKeyPassphraseInOrder", () => {
    expect(tlsFieldsOf(POSTGRES_PLUGIN).map((field) => field.key)).toEqual([
      "sslMode",
      "sslRootCert",
      "sslCert",
      "sslKey",
      "sslKeyPassphrase",
    ]);
    expect(tlsFieldsOf(SQLITE_PLUGIN)).toEqual([]);
  });

  it("givenCaFileWithRequire_whenNoted_thenSuggestsVerifyMode", () => {
    expect(caFileNote(withValues({ sslMode: "require", sslRootCert: "/ca.pem" }), POSTGRES_PLUGIN)).toBe(
      CA_FILE_UNUSED_NOTE,
    );
    expect(caFileNote(withValues({ sslMode: "disable", sslRootCert: "/ca.pem" }), POSTGRES_PLUGIN)).toBe(
      CA_FILE_UNUSED_NOTE,
    );
  });

  it("givenCaFileWithVerifyMode_whenNoted_thenNoNote", () => {
    expect(caFileNote(withValues({ sslMode: "verify-ca", sslRootCert: "/ca.pem" }), POSTGRES_PLUGIN)).toBeNull();
    expect(caFileNote(withValues({ sslMode: "require", sslRootCert: " " }), POSTGRES_PLUGIN)).toBeNull();
  });

  it("givenClientKey_whenSaveRequestBuilt_thenPassphraseKept", () => {
    const draft = withValues({ sslMode: "verify-full", sslKey: "~/client.key" });
    const typed = { ...draft, secrets: { ...draft.secrets, sslKeyPassphrase: { action: "set" as const, value: "p" } } };

    const request = toSaveRequest(typed, POSTGRES_PLUGIN);

    expect(request.datasource.config).toMatchObject({ sslKey: "~/client.key" });
    expect(request.datasource.secretModes).toEqual({ password: "forever", sslKeyPassphrase: "forever" });
    expect(request.secrets.sslKeyPassphrase).toEqual({ action: "set", value: "p" });
  });

  it("givenNoClientKey_whenSaveRequestBuilt_thenPassphraseDropped", () => {
    const request = toSaveRequest(withValues({ sslMode: "verify-full" }), POSTGRES_PLUGIN);

    expect(request.datasource.secretModes).not.toHaveProperty("sslKeyPassphrase");
    expect(request.secrets).not.toHaveProperty("sslKeyPassphrase");
  });
});
