import { createHmac } from "node:crypto";
import { fingerprintOf, type HostKeyOffer } from "@table-craft/core/tunnels/hostKeys.js";

/** File access the store is given, so it runs in tests without a disk; null when the file is missing. */
export interface KnownHostsFiles {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}

export type HostKeyCheck =
  | { readonly status: "trusted" }
  | { readonly status: "unknown" }
  | { readonly status: "changed"; readonly knownFingerprint: string; readonly file: string };

export interface KnownHosts {
  check(offer: HostKeyOffer): Promise<HostKeyCheck>;
  /** Records `offer` in the app's file, replacing any key of the same algorithm for the host. */
  trust(offer: HostKeyOffer): Promise<void>;
}

export interface KnownHostsOptions {
  /** `<userData>/ssh_known_hosts.json`, written on trust. */
  readonly appFile: string;
  /** `~/.ssh/known_hosts`, read only; null when there is no home directory. */
  readonly userFile: string | null;
  readonly files: KnownHostsFiles;
  readonly now?: () => number;
}

export const KNOWN_HOSTS_VERSION = 1;
const DEFAULT_SSH_PORT = 22;
const HASHED_PREFIX = "|1|";
const HASHED_SEPARATOR = "|";
const NEGATION = "!";
const MARKER = "@";
const COMMENT = "#";
const PATTERN_SEPARATOR = ",";
const JSON_INDENT = 2;

interface Entry {
  readonly algorithm: string;
  readonly key: string;
  readonly file: string;
}

interface StoredHost {
  readonly host: string;
  readonly algorithm: string;
  readonly key: string;
  readonly addedAt: number;
}

/** The name OpenSSH files a host under: bare for port 22, `[host]:port` otherwise. */
export function knownHostName(host: string, port: number): string {
  return port === DEFAULT_SSH_PORT ? host : `[${host}]:${String(port)}`;
}

function isStoredHost(value: unknown): value is StoredHost {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["host"] === "string" &&
    typeof record["algorithm"] === "string" &&
    typeof record["key"] === "string" &&
    typeof record["addedAt"] === "number"
  );
}

/** A corrupt or foreign file reads as empty; the next `trust` rewrites it whole. */
function parseAppFile(text: string | null): StoredHost[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return [];
    const hosts = (parsed as { hosts?: unknown }).hosts;
    return Array.isArray(hosts) ? hosts.filter(isStoredHost) : [];
  } catch {
    return [];
  }
}

function globMatches(pattern: string, name: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function hashedMatches(pattern: string, name: string): boolean {
  const [salt, hash] = pattern.slice(HASHED_PREFIX.length).split(HASHED_SEPARATOR);
  if (salt === undefined || hash === undefined) return false;
  return createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64") === hash;
}

/** OpenSSH's host list: comma-separated patterns, any negated match excludes the line (sshd(8) SSH_KNOWN_HOSTS FILE FORMAT). */
function hostsMatch(patterns: string, name: string): boolean {
  let matched = false;
  for (const pattern of patterns.split(PATTERN_SEPARATOR)) {
    if (pattern.startsWith(HASHED_PREFIX)) {
      matched ||= hashedMatches(pattern, name);
    } else if (pattern.startsWith(NEGATION)) {
      if (globMatches(pattern.slice(NEGATION.length), name)) return false;
    } else {
      matched ||= globMatches(pattern, name);
    }
  }
  return matched;
}

/** `@cert-authority` and `@revoked` lines are skipped: certificates are out of plan 036's scope. */
function openSshEntries(text: string | null, name: string, file: string): Entry[] {
  if (text === null) return [];
  const entries: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(COMMENT) || line.startsWith(MARKER)) continue;
    const [patterns, algorithm, key] = line.split(/\s+/);
    if (patterns === undefined || algorithm === undefined || key === undefined) continue;
    if (hostsMatch(patterns, name)) entries.push({ algorithm, key, file });
  }
  return entries;
}

export function createKnownHosts(options: KnownHostsOptions): KnownHosts {
  const { files, appFile, userFile } = options;
  const now = options.now ?? Date.now;
  let writing: Promise<void> = Promise.resolve();

  async function entriesFor(name: string): Promise<Entry[]> {
    const app = parseAppFile(await files.readText(appFile))
      .filter((stored) => stored.host === name)
      .map((stored) => ({ algorithm: stored.algorithm, key: stored.key, file: appFile }));
    const user = userFile === null ? [] : openSshEntries(await files.readText(userFile), name, userFile);
    return [...app, ...user];
  }

  return {
    async check(offer) {
      const entries = await entriesFor(knownHostName(offer.host, offer.port));
      const sameAlgorithm = entries.filter((entry) => entry.algorithm === offer.algorithm);
      if (sameAlgorithm.some((entry) => entry.key === offer.key)) return { status: "trusted" };
      const known = sameAlgorithm[0];
      if (known === undefined) return { status: "unknown" };
      return {
        status: "changed",
        knownFingerprint: fingerprintOf(Buffer.from(known.key, "base64")),
        file: known.file,
      };
    },
    trust(offer) {
      const name = knownHostName(offer.host, offer.port);
      const write = async (): Promise<void> => {
        const kept = parseAppFile(await files.readText(appFile)).filter(
          (stored) => stored.host !== name || stored.algorithm !== offer.algorithm,
        );
        const hosts = [...kept, { host: name, algorithm: offer.algorithm, key: offer.key, addedAt: now() }];
        await files.writeText(
          appFile,
          `${JSON.stringify({ version: KNOWN_HOSTS_VERSION, hosts }, null, JSON_INDENT)}\n`,
        );
      };
      writing = writing.then(write, write);
      return writing;
    },
  };
}
