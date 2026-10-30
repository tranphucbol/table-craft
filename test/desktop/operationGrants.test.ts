import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationFileGrants, type OperationOwner } from "@table-craft/desktop/main/operationGrants.js";
import { TransientCredentials, type CredentialOwner } from "@table-craft/desktop/main/transientCredentials.js";

const directories: string[] = [];
const OWNER: OperationOwner = { engineId: "engine", ownerId: "window", operation: "cluster.snapshot" };
const CREDENTIAL_OWNER: CredentialOwner = { engineId: "engine", ownerId: "window", operation: "access.secret.apply" };
const MAX_BYTES = 4096;

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tablecraft-grants-"));
  directories.push(path);
  return path;
}

async function* parts(value: Buffer): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield value.subarray(0, 17);
  yield value.subarray(17);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("operation file grants", () => {
  it("givenCompleteSnapshot_whenPublished_thenChecksumVerifiedAndGrantConsumed", async () => {
    const root = await directory();
    const destination = join(root, "snapshot.db");
    const grants = new OperationFileGrants();
    const id = (await grants.choose(OWNER, () => Promise.resolve(destination)))!;
    const payload = Buffer.alloc(512, 7);
    const snapshot = Buffer.concat([payload, createHash("sha256").update(payload).digest()]);
    await expect(grants.publish(id, OWNER, parts(snapshot), MAX_BYTES)).resolves.toEqual({ bytes: snapshot.length });
    expect(await readFile(destination)).toEqual(snapshot);
    expect(await readdir(root)).toEqual(["snapshot.db"]);
    await expect(grants.publish(id, OWNER, parts(snapshot), MAX_BYTES)).rejects.toThrow("authorization");
  });

  it("givenBadChecksumOrFailedSource_whenPublished_thenNothingPublishedOrLeftBehind", async () => {
    const root = await directory();
    const grants = new OperationFileGrants();
    const destination = join(root, "snapshot.db");
    const id = (await grants.choose(OWNER, () => Promise.resolve(destination)))!;
    await expect(grants.publish(id, OWNER, parts(Buffer.alloc(544)), MAX_BYTES)).rejects.toThrow("checksum");
    const next = (await grants.choose(OWNER, () => Promise.resolve(destination)))!;
    async function* failed(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield Buffer.alloc(512);
      throw new Error("non-OK status");
    }
    await expect(grants.publish(next, OWNER, failed(), MAX_BYTES)).rejects.toThrow("non-OK");
    expect(await readdir(root)).toEqual([]);
  });

  it("givenWrongOwnerAndConcurrentDestination_whenPublished_thenNoOverwrite", async () => {
    const root = await directory();
    const destination = join(root, "export.json");
    const owner: OperationOwner = { ...OWNER, operation: "transfer.export" };
    const grants = new OperationFileGrants();
    const id = (await grants.choose(owner, () => Promise.resolve(destination)))!;
    await expect(
      grants.publish(id, { ...owner, ownerId: "other" }, parts(Buffer.from("new")), MAX_BYTES),
    ).rejects.toThrow("authorization");
    await writeFile(destination, "existing");
    await expect(grants.publish(id, owner, parts(Buffer.from("new")), MAX_BYTES)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("existing");
    expect(await readdir(root)).toEqual(["export.json"]);
  });

  it("givenSymlinkInput_whenAuthorized_thenRejected", async () => {
    const root = await directory();
    const target = join(root, "real");
    const path = join(root, "link");
    await writeFile(target, "private");
    await symlink(target, path);
    await expect(
      new OperationFileGrants().choose({ ...OWNER, operation: "transfer.import" }, () => Promise.resolve(path)),
    ).rejects.toThrow("symbolic link");
  });
});

describe("transient write-only credentials", () => {
  it("givenBoundCredential_whenApplied_thenSingleUseAndBufferErased", async () => {
    const credentials = new TransientCredentials();
    const id = credentials.issue(CREDENTIAL_OWNER, "private-password");
    let retained: Uint8Array | undefined;
    await expect(credentials.apply(id, { ...CREDENTIAL_OWNER, engineId: "other" }, async () => {})).rejects.toThrow(
      "authorization",
    );
    await credentials.apply(id, CREDENTIAL_OWNER, async (bytes) => {
      await Promise.resolve();
      expect(Buffer.from(bytes).toString()).toBe("private-password");
      retained = bytes;
    });
    expect(retained?.every((byte) => byte === 0)).toBe(true);
    await expect(credentials.apply(id, CREDENTIAL_OWNER, async () => {})).rejects.toThrow("authorization");
  });

  it("givenRawDriverFailure_whenApplied_thenSecretAndCauseNeverEscape", async () => {
    const credentials = new TransientCredentials();
    const id = credentials.issue(CREDENTIAL_OWNER, "private-password");
    const cause: unknown = await credentials
      .apply(id, CREDENTIAL_OWNER, async () => {
        await Promise.resolve();
        throw new Error("request password=private-password");
      })
      .catch((error: unknown) => error);
    expect(String(cause)).not.toContain("private-password");
    expect(cause).not.toHaveProperty("cause");
  });
});
