#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  complianceMetadata,
} from './capabilities.js';
import { buildSupportProjection } from '../../../scripts/support-projection.js';

// This build-time script also runs before package dist files exist.
const nearbyPackage = fileURLToPath(new URL('..', import.meta.url));
const packageDirectory = existsSync(path.join(nearbyPackage, 'package.json'))
  ? nearbyPackage
  : fileURLToPath(new URL('../../../../packages/golem-openapi/', import.meta.url));

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

/**
 * Render only the consumer support view. The registry still carries its full
 * evidence model and is validated by complianceMetadata(), but those details
 * never become package or documentation content.
 */
export function renderComplianceMatrix(): string {
  const metadata = complianceMetadata();
  const projection = buildSupportProjection(metadata);
  const statusMeanings = projection.statuses
    .map(({ label, meaning }) => `- **${label}**: ${meaning}.`)
    .join('\n');
  const rows = projection.capabilities.map((record) => {
    const limitations = record.limitations.map(escapeCell).join('<br>');
    return `| ${escapeCell(record.title)} | ${record.version} | ${record.surface} | ${record.mobx ? 'On' : 'Off'} | ${record.validation ? 'On' : 'Off'} | ${escapeCell(record.statusLabel)} | ${limitations} |`;
  });

  return `# OpenAPI support matrix

This table lists support for each OpenAPI feature, version, generated surface,
and generation profile. Read the limitation column with the status when you
choose settings for an application.

Status meanings:

${statusMeanings}

| Feature | Version | Surface | MobX | Validation | Status | Limitations |
|---|---:|---|---|---|---|---|
${rows.join('\n')}
`;
}

export function renderCapabilitiesMetadata(): string {
  return `${JSON.stringify(complianceMetadata(), null, 2)}\n`;
}

export function writeIfChanged(filename: string, content: string): void {
  if (existsSync(filename) && readFileSync(filename, 'utf8') === content) return;
  writeFileSync(filename, content);
}

export function writeComplianceMatrix(): void {
  writeIfChanged(path.join(packageDirectory, 'MATRIX.md'), renderComplianceMatrix());
  writeIfChanged(path.join(packageDirectory, 'compliance', 'capabilities.json'), renderCapabilitiesMetadata());
}

export function checkComplianceMatrix(): void {
  writeComplianceMatrix();
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  try {
    if (process.argv.includes('--check')) checkComplianceMatrix();
    else writeComplianceMatrix();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
