import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KNOWN_HOSTS_VERSION,
  createKnownHosts,
  fingerprintOf,
  knownHostName,
  type HostKeyOffer,
  type KnownHostsFiles,
} from "@table-craft/core";

const APP_FILE = "/user-data/ssh_known_hosts.json";
const USER_FILE = "/home/me/.ssh/known_hosts";
const NOW = 1_761_300_000_000;

function blob(algorithm: string, body: string): Buffer {
  const name = Buffer.from(algorithm);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, Buffer.from(body)]);
}

function offer(host: string, port: number, key: Buffer, algorithm = "ssh-ed25519"): HostKeyOffer {
  return { host, port, algorithm, fingerprint: fingerprintOf(key), key: key.toString("base64") };
}

function memoryFiles(initial: Record<string, string> = {}): KnownHostsFiles & { readonly texts: Map<string, string> } {
  const texts = new Map(Object.entries(initial));
  return {
    texts,
    readText: (path) => Promise.resolve(texts.get(path) ?? null),
    writeText: (path, text) => {
      texts.set(path, text);
      return Promise.resolve();
    },
  };
}

function store(files: KnownHostsFiles) {
  return createKnownHosts({ appFile: APP_FILE, userFile: USER_FILE, files, now: () => NOW });
}

const KEY = blob("ssh-ed25519", "bastion-key");
const OTHER_KEY = blob("ssh-ed25519", "imposter-key");

describe("createKnownHosts", () => {
  it("givenUnknownHostKey_whenChecked_thenUnknown", async () => {
    expect(await store(memoryFiles()).check(offer("bastion", 22, KEY))).toEqual({ status: "unknown" });
  });

  it("givenTrustedKey_whenCheckedAgain_thenTrustedAndStoredAsOpenSshNames", async () => {
    const files = memoryFiles();
    const known = store(files);

    await known.trust(offer("bastion", 2204, KEY));

    expect(await known.check(offer("bastion", 2204, KEY))).toEqual({ status: "trusted" });
    expect(JSON.parse(files.texts.get(APP_FILE) ?? "")).toEqual({
      version: KNOWN_HOSTS_VERSION,
      hosts: [{ host: "[bastion]:2204", algorithm: "ssh-ed25519", key: KEY.toString("base64"), addedAt: NOW }],
    });
  });

  it("givenChangedHostKey_whenChecked_thenChangedWithStoredFingerprintAndFile", async () => {
    const known = store(memoryFiles());
    await known.trust(offer("bastion", 22, KEY));

    expect(await known.check(offer("bastion", 22, OTHER_KEY))).toEqual({
      status: "changed",
      knownFingerprint: fingerprintOf(KEY),
      file: APP_FILE,
    });
  });

  it("givenSameHostOtherPort_whenChecked_thenUnknown", async () => {
    const known = store(memoryFiles());
    await known.trust(offer("bastion", 22, KEY));

    expect(await known.check(offer("bastion", 2204, KEY))).toEqual({ status: "unknown" });
  });

  it("givenOnlyOtherAlgorithmKnown_whenChecked_thenUnknown", async () => {
    const known = store(memoryFiles());
    await known.trust(offer("bastion", 22, blob("ssh-rsa", "rsa"), "ssh-rsa"));

    expect(await known.check(offer("bastion", 22, KEY))).toEqual({ status: "unknown" });
  });

  it("givenRetrust_whenTrusted_thenReplacesTheOldKeyOfThatAlgorithm", async () => {
    const files = memoryFiles();
    const known = store(files);
    await known.trust(offer("bastion", 22, KEY));

    await known.trust(offer("bastion", 22, OTHER_KEY));

    expect(await known.check(offer("bastion", 22, OTHER_KEY))).toEqual({ status: "trusted" });
    expect((JSON.parse(files.texts.get(APP_FILE) ?? "") as { hosts: unknown[] }).hosts).toHaveLength(1);
  });

  it("givenOpenSshEntry_whenChecked_thenTrustedWithoutWriting", async () => {
    const files = memoryFiles({
      [USER_FILE]: `# comment\nother.host ssh-ed25519 ${OTHER_KEY.toString("base64")}\nbastion,10.0.0.1 ssh-ed25519 ${KEY.toString("base64")} me@laptop\n`,
    });

    expect(await store(files).check(offer("10.0.0.1", 22, KEY))).toEqual({ status: "trusted" });
    expect(files.texts.has(APP_FILE)).toBe(false);
  });

  it("givenHashedOpenSshEntry_whenChecked_thenTrusted", async () => {
    const salt = randomBytes(20);
    const hash = createHmac("sha1", salt).update(knownHostName("bastion", 2204)).digest("base64");
    const files = memoryFiles({
      [USER_FILE]: `|1|${salt.toString("base64")}|${hash} ssh-ed25519 ${KEY.toString("base64")}\n`,
    });

    expect(await store(files).check(offer("bastion", 2204, KEY))).toEqual({ status: "trusted" });
  });

  it("givenChangedKeyInOpenSshFile_whenChecked_thenNamesThatFile", async () => {
    const files = memoryFiles({ [USER_FILE]: `bastion ssh-ed25519 ${KEY.toString("base64")}\n` });

    expect(await store(files).check(offer("bastion", 22, OTHER_KEY))).toEqual({
      status: "changed",
      knownFingerprint: fingerprintOf(KEY),
      file: USER_FILE,
    });
  });

  it("givenWildcardAndNegatedPatterns_whenChecked_thenOpenSshMatchingRules", async () => {
    const files = memoryFiles({
      [USER_FILE]: `*.internal,!secret.internal ssh-ed25519 ${KEY.toString("base64")}\n@revoked * ssh-ed25519 ${KEY.toString("base64")}\n`,
    });
    const known = store(files);

    expect(await known.check(offer("db.internal", 22, KEY))).toEqual({ status: "trusted" });
    expect(await known.check(offer("secret.internal", 22, KEY))).toEqual({ status: "unknown" });
  });

  it("givenCorruptAppFile_whenTrusted_thenRewritten", async () => {
    const files = memoryFiles({ [APP_FILE]: "{not json" });
    const known = store(files);

    expect(await known.check(offer("bastion", 22, KEY))).toEqual({ status: "unknown" });
    await known.trust(offer("bastion", 22, KEY));

    expect(await known.check(offer("bastion", 22, KEY))).toEqual({ status: "trusted" });
  });

  it("givenConcurrentTrusts_whenWritten_thenBothKept", async () => {
    const files = memoryFiles();
    const known = store(files);

    await Promise.all([known.trust(offer("a", 22, KEY)), known.trust(offer("b", 22, OTHER_KEY))]);

    expect(await known.check(offer("a", 22, KEY))).toEqual({ status: "trusted" });
    expect(await known.check(offer("b", 22, OTHER_KEY))).toEqual({ status: "trusted" });
  });
});
