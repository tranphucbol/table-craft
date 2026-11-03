const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver order: -1, 0 or 1. A prerelease sorts below its release, so `0.0.0-dev.<sha>`, what a
 * packaged build off an untagged commit reports (decision 033), is older than every release.
 */
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (a === null || b === null) throw new Error(`"${a === null ? left : right}" is not a semver version.`);
  for (let index = 1; index <= 3; index += 1) {
    const order = Math.sign(Number(a[index]) - Number(b[index]));
    if (order !== 0) return order;
  }
  const [preA, preB] = [a[4], b[4]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split(".");
  const partsB = preB.split(".");
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const [partA, partB] = [partsA[index], partsB[index]];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const order = compareIdentifiers(partA, partB);
    if (order !== 0) return order;
  }
  return 0;
}
