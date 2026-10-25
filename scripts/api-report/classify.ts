/**
 * Classifies the difference between two surface reports and says which `API_VERSION` it needs
 * (decision 107): an addition needs the next minor, a break the next major.
 */
import type { SurfaceMember, SurfaceModel, SurfaceSymbol } from "./model.js";

export type ChangeKind = "addition" | "breaking" | "unclassified";

export interface SurfaceChange {
  /** `Symbol` or `Symbol.member`, the key `compatibility.json` classifies. */
  key: string;
  kind: ChangeKind;
  description: string;
}

export type ReviewedKind = "addition" | "breaking";

export interface Classification {
  key: string;
  kind: ReviewedKind;
  reason: string;
}

/** `packages/plugin-api/api/compatibility.json`: reviewed verdicts for changes the tool cannot judge. */
export interface CompatibilityFile {
  classifications: Classification[];
}

export class CompatibilityFileError extends Error {
  override name = "CompatibilityFileError";
}

const REVIEWED_KINDS: readonly ReviewedKind[] = ["addition", "breaking"];

export function parseCompatibilityFile(text: string): CompatibilityFile {
  const value: unknown = JSON.parse(text);
  const list =
    typeof value === "object" && value !== null ? (value as { classifications?: unknown }).classifications : null;
  if (!Array.isArray(list)) throw new CompatibilityFileError('compatibility.json needs a "classifications" array.');
  const classifications = list.map((item: unknown, index): Classification => {
    const { key, kind, reason } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof key !== "string" || typeof reason !== "string" || reason.trim() === "") {
      throw new CompatibilityFileError(`classifications[${index}] needs a "key" and a non-empty "reason".`);
    }
    if (!REVIEWED_KINDS.includes(kind as ReviewedKind)) {
      throw new CompatibilityFileError(`classifications[${index}].kind must be "addition" or "breaking".`);
    }
    return { key, kind: kind as ReviewedKind, reason };
  });
  return { classifications };
}

function memberChanges(
  symbol: string,
  before: SurfaceMember | undefined,
  after: SurfaceMember | undefined,
): SurfaceChange[] {
  const key = `${symbol}.${(before ?? after)?.key ?? ""}`;
  if (after === undefined) return [{ key, kind: "breaking", description: `${key} was removed` }];
  if (before === undefined) {
    return after.optional
      ? [{ key, kind: "addition", description: `${key} was added, optional` }]
      : [{ key, kind: "breaking", description: `${key} was added as a required member` }];
  }
  const changes: SurfaceChange[] = [];
  if (before.texts.join("\n") !== after.texts.join("\n")) {
    changes.push({
      key,
      kind: "unclassified",
      description: `${key} changed from \`${before.texts.join(" ")}\` to \`${after.texts.join(" ")}\``,
    });
  }
  if (!before.deprecated && after.deprecated) {
    changes.push({ key, kind: "addition", description: `${key} was deprecated` });
  }
  return changes;
}

function symbolChanges(
  name: string,
  before: SurfaceSymbol | undefined,
  after: SurfaceSymbol | undefined,
): SurfaceChange[] {
  if (after === undefined) {
    // A reachable but unexported type cannot be named by a plugin; what reached it changes instead.
    if (before?.exported === false) return [];
    return [{ key: name, kind: "breaking", description: `${name} was removed` }];
  }
  if (before === undefined) return [{ key: name, kind: "addition", description: `${name} was added` }];
  const changes: SurfaceChange[] = [];
  if (before.exported && !after.exported) {
    changes.push({ key: name, kind: "breaking", description: `${name} is no longer exported` });
  }
  if (!before.exported && after.exported) {
    changes.push({ key: name, kind: "addition", description: `${name} is now exported` });
  }
  if (before.header !== after.header || (before.members === null) !== (after.members === null)) {
    changes.push({
      key: name,
      kind: "unclassified",
      description: `${name} changed from \`${before.header}\` to \`${after.header}\``,
    });
  }
  if (!before.deprecated && after.deprecated) {
    changes.push({ key: name, kind: "addition", description: `${name} was deprecated` });
  }
  if (before.members !== null && after.members !== null) {
    const keys = new Set([...before.members.keys(), ...after.members.keys()]);
    for (const key of [...keys].sort()) {
      changes.push(...memberChanges(name, before.members.get(key), after.members.get(key)));
    }
  }
  return changes;
}

function isRemoval(change: SurfaceChange): boolean {
  return change.kind === "breaking" && change.description.endsWith(" was removed");
}

/**
 * Every change from `baseline` to `current`, with the reviewed verdicts applied. A verdict may
 * settle a changed signature or a new required member; it cannot turn a removal into an addition.
 */
export function classify(
  baseline: SurfaceModel,
  current: SurfaceModel,
  compatibility: CompatibilityFile = { classifications: [] },
): SurfaceChange[] {
  const names = new Set([...baseline.symbols.keys(), ...current.symbols.keys()]);
  const changes = [...names]
    .sort()
    .flatMap((name) => symbolChanges(name, baseline.symbols.get(name), current.symbols.get(name)));
  return changes.map((change) => {
    const verdict = compatibility.classifications.find((classification) => classification.key === change.key);
    if (verdict === undefined || isRemoval(change) || change.kind === "addition") return change;
    return { ...change, kind: verdict.kind, description: `${change.description} (${verdict.kind}: ${verdict.reason})` };
  });
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parse(version: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new CompatibilityFileError(`"${version}" is not a major.minor.patch version.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** The lowest `API_VERSION` that may carry `changes` on top of `baselineVersion`. */
export function requiredVersion(baselineVersion: string, changes: readonly SurfaceChange[]): string {
  const base = parse(baselineVersion);
  if (changes.some((change) => change.kind === "breaking")) return `${base.major + 1}.0.0`;
  if (changes.some((change) => change.kind === "addition")) return `${base.major}.${base.minor + 1}.0`;
  return baselineVersion;
}

function atLeast(version: Version, floor: Version): boolean {
  if (version.major !== floor.major) return version.major > floor.major;
  if (version.minor !== floor.minor) return version.minor > floor.minor;
  return version.patch >= floor.patch;
}

function listed(changes: readonly SurfaceChange[]): string {
  return changes.map((change) => `  - ${change.description}`).join("\n");
}

/** What is wrong with `currentVersion` for `changes`; empty when the version suffices. */
export function checkVersion(
  baselineVersion: string,
  currentVersion: string,
  changes: readonly SurfaceChange[],
): string[] {
  const problems: string[] = [];
  const unclassified = changes.filter((change) => change.kind === "unclassified");
  if (unclassified.length > 0) {
    problems.push(
      "These changes need a verdict in packages/plugin-api/api/compatibility.json " +
        '({ "key", "kind": "addition" | "breaking", "reason" }): a type a plugin receives may only narrow, ' +
        `one it returns or implements may only widen.\n${listed(unclassified)}`,
    );
  }
  const required = requiredVersion(baselineVersion, changes);
  if (atLeast(parse(currentVersion), parse(required))) return problems;
  const breaking = changes.filter((change) => change.kind === "breaking");
  if (breaking.length > 0) {
    problems.push(
      `These changes break plugins built for ${baselineVersion} and need API_VERSION ${required}, a new major, ` +
        `which only the user may take; keep the old shape (deprecate it) instead.\n${listed(breaking)}`,
    );
  } else if (required === baselineVersion) {
    problems.push(`API_VERSION ${currentVersion} is below the release's ${baselineVersion}; it never goes back.`);
  } else {
    const additions = changes.filter((change) => change.kind === "addition");
    problems.push(
      `These additions need API_VERSION ${required} (the release has ${baselineVersion}, the source ${currentVersion}); ` +
        `bump it in packages/plugin-api/src/version.ts and the built-in manifests.\n${listed(additions)}`,
    );
  }
  return problems;
}
