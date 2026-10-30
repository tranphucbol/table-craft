import { describe, expect, it } from "vitest";
import { admitConsoleCommand } from "@table-craft/plugin-etcd/language";
import plugin from "@table-craft/plugin-etcd";

const SECRET = "hunter2";
const LEASE_HEX = "694d77aa9e38260f";

describe("etcd console admission", () => {
  it("givenPluginEntry_whenRead_thenCommandLanguageAdmits", () => {
    expect(plugin.commandLanguage).toHaveProperty("admit", admitConsoleCommand);
  });

  it.each([
    "user add alice hunter2",
    "user add alice:hunter2",
    "user passwd alice hunter2",
    'user add "alice hunter2',
    "user add alice --hunter2",
    "user add",
    'user add ""',
    "txn\nthen: user add alice hunter2\nend",
    "USER ADD alice:hunter2",
  ])("givenCredentialText_whenAdmitted_thenRejectedWithoutEchoingIt %#", (text) => {
    const answer = admitConsoleCommand(text);

    expect(answer).toEqual({ admit: "reject", safeLabel: "credential command" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain("alice");
  });

  it.each([
    ["user add alice", "createUser"],
    ["user passwd alice", "changePassword"],
    ['user passwd "alice"', "changePassword"],
  ] as const)("givenUserNameOnly_whenAdmitted_thenCredentialManagerWithTrustedName %#", (text, change) => {
    expect(admitConsoleCommand(text)).toEqual({
      admit: "managed",
      intent: "credentials",
      arguments: { kind: "credentials", change, user: "alice" },
      safeLabel: text.startsWith("user add") ? "user add" : "user passwd",
    });
  });

  it("givenWatch_whenAdmitted_thenManagedWithNormalizedRequest", () => {
    expect(admitConsoleCommand("watch /app --prefix")).toMatchObject({
      admit: "managed",
      intent: "watch",
      arguments: { kind: "watch", request: { database: 0, range: { kind: "prefix" }, from: { kind: "now" } } },
      safeLabel: "watch",
    });
  });

  it("givenLeaseRevoke_whenAdmitted_thenSignedDecimalLeaseId", () => {
    const leaseId = BigInt.asIntN(64, BigInt(`0x${LEASE_HEX}`)).toString();

    expect(admitConsoleCommand(`lease revoke ${LEASE_HEX}`)).toEqual({
      admit: "managed",
      intent: "leaseRevoke",
      arguments: { kind: "leaseRevoke", leaseId },
      safeLabel: "lease revoke",
    });
  });

  it("givenContinuousKeepAlive_whenAdmitted_thenManagedRenewal", () => {
    expect(admitConsoleCommand(`lease keep-alive ${LEASE_HEX}`)).toMatchObject({
      admit: "managed",
      intent: "keepAlive",
      arguments: { kind: "keepAlive" },
    });
  });

  it.each(["get /app/a", "put /app/a 1", "lease keep-alive 1 --once", "member list", "txn\nthen: put a 1\nend"])(
    "givenOrdinaryCommand_whenAdmitted_thenExecutes %#",
    (text) => {
      expect(admitConsoleCommand(text).admit).toBe("execute");
    },
  );

  it.each([
    ["snapshot save", "snapshot"],
    ["member remove 8e9e05c52164694d", "cluster"],
    ["user delete alice", "access"],
    ["compaction 5", "admin"],
  ] as const)("givenGlobalAdministrativeCommand_whenAdmitted_thenManagerWithoutPreset %#", (text, intent) => {
    expect(admitConsoleCommand(text)).toMatchObject({ admit: "managed", intent, arguments: { kind: "none" } });
  });

  it("givenLeaseZero_whenAdmitted_thenNeverManaged", () => {
    expect(admitConsoleCommand("lease revoke 0").admit).not.toBe("managed");
  });
});
