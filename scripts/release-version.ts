import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_NAMES, assertExampleInventory } from './maintained-examples.js';

export const PUBLIC_PACKAGE_NAMES = [
  '@exprtlabs/codegen',
  '@exprtlabs/model-codegen',
  '@exprtlabs/openapi-to-ts',
  '@exprtlabs/ts-to-openapi',
] as const;

type PublicPackageName = (typeof PUBLIC_PACKAGE_NAMES)[number];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filename: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!record(value)) throw new TypeError(`Expected a JSON object: ${filename}`);
  return value;
}

function readPackageManifest(filename: string): Record<string, unknown> {
  const manifest = readJson(filename);
  if (typeof manifest.name !== 'string') throw new TypeError(`Package name is missing: ${filename}`);
  return manifest;
}

export function readWorkspaceReleaseVersion(workspaceRoot: string): string {
  const filename = path.join(path.resolve(workspaceRoot), 'package.json');
  const manifest = readJson(filename);
  if (manifest.private !== true || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`Workspace release version is missing from ${filename}`);
  }
  return manifest.version;
}

function packageManifestByName(workspaceRoot: string, expectedName: PublicPackageName): { readonly filename: string; readonly manifest: Record<string, unknown> } {
  const packageRoot = path.join(path.resolve(workspaceRoot), 'packages');
  for (const folder of fs.readdirSync(packageRoot).sort()) {
    const filename = path.join(packageRoot, folder, 'package.json');
    if (!fs.existsSync(filename)) continue;
    const manifest = readPackageManifest(filename);
    if (manifest.name === expectedName) return { filename, manifest };
  }
  throw new Error(`Missing public package manifest: ${expectedName}`);
}

function exactInternalPins(manifest: Record<string, unknown>, releaseVersion: string, filename: string): void {
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = manifest[sectionName];
    if (!record(section)) continue;
    for (const packageName of PUBLIC_PACKAGE_NAMES) {
      if (packageName in section && section[packageName] !== releaseVersion) {
        throw new Error(`${filename} must pin ${packageName} to ${releaseVersion}; found ${String(section[packageName])}`);
      }
    }
  }
}

export function assertReleaseConsistency(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const releaseVersion = readWorkspaceReleaseVersion(root);
  for (const packageName of PUBLIC_PACKAGE_NAMES) {
    const { filename, manifest } = packageManifestByName(root, packageName);
    if (manifest.version !== releaseVersion) {
      throw new Error(`${packageName} must use workspace version ${releaseVersion}; found ${String(manifest.version)}`);
    }
    const publishConfig = manifest.publishConfig;
    if (!record(publishConfig) || publishConfig.access !== 'public' || publishConfig.tag !== 'rc') {
      throw new Error(`${packageName} must publish publicly with the rc tag`);
    }
    exactInternalPins(manifest, releaseVersion, filename);
  }

  assertExampleInventory(root);
  for (const exampleName of EXAMPLE_NAMES) {
    const filename = path.join(root, 'examples', exampleName, 'package.json');
    const manifest = readPackageManifest(filename);
    exactInternalPins(manifest, releaseVersion, filename);
  }
  return releaseVersion;
}
