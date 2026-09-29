interface Parsed { readonly core: readonly number[]; readonly pre: readonly string[] }

function parse(version: string): Parsed {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 1 : 0) - (b.length === 0 ? 1 : 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index], right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    const order = numeric ? Number(left) - Number(right) : left.localeCompare(right);
    if (order !== 0) return Math.sign(order);
  }
  return 0;
}

export function compareReleaseVersions(a: string, b: string): number {
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const order = left.core[index]! - right.core[index]!;
    if (order !== 0) return Math.sign(order);
  }
  return comparePre(left.pre, right.pre);
}

export function assertRuntimeCompatible(
  runtime: { readonly name: string; readonly version: string },
  generator: { readonly name: string; readonly version: string },
): void {
  if (parse(runtime.version).core[0] !== parse(generator.version).core[0]) {
    throw new Error(`${runtime.name} ${runtime.version} and ${generator.name} ${generator.version} have different major versions. Install matching major versions.`);
  }
  if (compareReleaseVersions(runtime.version, generator.version) < 0) {
    throw new Error(`${runtime.name} ${runtime.version} is older than ${generator.name} ${generator.version}. Update ${runtime.name} to ${generator.version} or later.`);
  }
}
