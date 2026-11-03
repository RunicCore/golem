import fs from 'node:fs';

export const apiVersion = 1;

export function generate() {
  return JSON.parse(fs.readFileSync(new URL('./provider-result.json', import.meta.url), 'utf8'));
}
