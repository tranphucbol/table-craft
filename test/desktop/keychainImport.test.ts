import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialReader, runCommand } from "@table-craft/desktop/main/import/keychain.js";
import { DATAGRIP_IDS, dataGripService } from "../support/import/fixtures.js";

const SECURITY = "/usr/bin/security";
const KEYCHAIN_PASSWORD = "table-craft-test";
const SECRET = "p@ss w\u00f6rd";
const PLAIN_SECRET = "deadbeef";

/**
 * The macOS reader against a real keychain: a temporary one made for this suite, searched by path
 * so the login keychain is never read, and deleted afterwards. `-T /usr/bin/security` puts the
 * tool on the item's access list, so no prompt appears.
 */
describe.runIf(process.platform === "darwin")("macOS keychain import", () => {
  let directory = "";
  let keychain = "";
  let searchList: string[] = [];

  function security(...args: string[]): string {
    return execFileSync(SECURITY, args, { encoding: "utf8" });
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "tc-keychain-"));
    keychain = join(directory, "import-test.keychain-db");
    searchList = [...security("list-keychains", "-d", "user").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    security("create-keychain", "-p", KEYCHAIN_PASSWORD, keychain);
    // create-keychain adds the file to the user's search list; put the list back as it was.
    security("list-keychains", "-d", "user", "-s", ...searchList);
    security("unlock-keychain", "-p", KEYCHAIN_PASSWORD, keychain);
    security(
      "add-generic-password",
      "-s",
      dataGripService(DATAGRIP_IDS.shopMysql),
      "-a",
      "table_craft",
      "-w",
      SECRET,
      "-T",
      SECURITY,
      keychain,
    );
    security(
      "add-generic-password",
      "-s",
      dataGripService(DATAGRIP_IDS.shopPostgres),
      "-a",
      "table_craft",
      "-w",
      PLAIN_SECRET,
      "-T",
      SECURITY,
      keychain,
    );
  });

  afterAll(() => {
    if (keychain !== "") {
      try {
        security("delete-keychain", keychain);
      } finally {
        security("list-keychains", "-d", "user", "-s", ...searchList);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("givenDataGripItem_whenLookedUp_thenFoundWithoutPrompt", async () => {
    const reader = createCredentialReader({ platform: "darwin", run: runCommand, keychains: [keychain] });

    expect(await reader.lookup(dataGripService(DATAGRIP_IDS.shopMysql))).toEqual({ status: "found", value: SECRET });
  });

  it("givenHexLookingPassword_whenLookedUp_thenReturnedAsTyped", async () => {
    const reader = createCredentialReader({ platform: "darwin", run: runCommand, keychains: [keychain] });

    expect(await reader.lookup(dataGripService(DATAGRIP_IDS.shopPostgres))).toEqual({
      status: "found",
      value: PLAIN_SECRET,
    });
  });

  it("givenMissingItem_whenLookedUp_thenNotFound", async () => {
    const reader = createCredentialReader({ platform: "darwin", run: runCommand, keychains: [keychain] });

    expect(await reader.lookup(dataGripService(DATAGRIP_IDS.global))).toEqual({ status: "notFound" });
  });
});
