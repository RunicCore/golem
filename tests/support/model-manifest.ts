import fs from 'node:fs';

/** Writes the model manifest that lists `Money`, declared in `./types.ts`. */
export function writeMoneyManifest(manifest: string): void {
  fs.writeFileSync(manifest, JSON.stringify({
    profile: { validation: false, allowAny: false, unknownFormats: 'error' },
    models: [{
      id: 'fixture:money',
      codecId: 'Money_0a1b2c3d',
      allowAny: false,
      type: { module: './types.ts', export: 'Money' },
    }],
  }));
}
