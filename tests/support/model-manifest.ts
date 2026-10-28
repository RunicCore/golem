import fs from 'node:fs';

/** Writes the model manifest that names `Money` in `./types.ts` and `generatedExport`, its generated class, in `./models.ts`. */
export function writeMoneyManifest(manifest: string, generatedExport: string): void {
  fs.writeFileSync(manifest, JSON.stringify({
    profile: { mobx: false, validation: false, allowAny: false, unknownFormats: 'error' },
    models: [{
      id: 'fixture:money',
      codecId: 'Money_0a1b2c3d',
      allowAny: false,
      type: { module: './types.ts', export: 'Money' },
      generated: { module: './models.ts', export: generatedExport },
    }],
  }));
}
