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

function generatedFiles(directory: string): Array<{ filename: string; content: string }> {
  return [
    { filename: path.join(directory, 'MATRIX.md'), content: renderComplianceMatrix() },
    { filename: path.join(directory, 'compliance', 'capabilities.json'), content: renderCapabilitiesMetadata() },
  ];
}

export function writeComplianceMatrix(directory: string = packageDirectory): void {
  for (const { filename, content } of generatedFiles(directory)) writeIfChanged(filename, content);
}

/** Compare the generated files with the files on disk and write nothing. */
export function checkComplianceMatrix(directory: string = packageDirectory): void {
  const stale = generatedFiles(directory)
    .filter(({ filename, content }) => !existsSync(filename) || readFileSync(filename, 'utf8') !== content)
    .map(({ filename }) => path.relative(directory, filename));
  if (stale.length === 0) return;
  throw new Error(
    `The OpenAPI compliance files are stale: ${stale.join(', ')}. Run npm run generate:openapi-compliance.`,
  );
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
