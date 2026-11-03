import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
const manifest = JSON.parse(fs.readFileSync(new URL('./fixture-manifest.json', import.meta.url), 'utf8'));
export function generate(context) {
  const filename = path.join(context.output, 'model-manifest.json');
  return {
    apiVersion: 1,
    artifacts: [{ path: filename, content: JSON.stringify(manifest) }],
    manifestPaths: [filename],
    watchInputs: [context.input],
  };
}
