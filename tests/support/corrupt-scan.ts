import type { TestContext } from 'node:test';

import { RewriteScanner, type FileScanResult } from '#golem/rewrite-scan';

/** The result with every edit expecting text the file does not hold: applying it is an inconsistent rewrite. */
function corrupted(result: FileScanResult): FileScanResult {
  return { ...result, edits: result.edits.map((edit) => ({ ...edit, expect: `${edit.expect}\u0000not in the file` })) };
}

/** Makes every scan of the scanner, by file or by program, answer edits that no longer match their text. */
export function corruptScans(t: TestContext): void {
  const scanFile = RewriteScanner.prototype.scanFile;
  t.mock.method(RewriteScanner.prototype, 'scanFile', function (this: RewriteScanner, filename: string) {
    const result = scanFile.call(this, filename);
    return result && corrupted(result);
  });
  const scanFiles = RewriteScanner.prototype.scanFiles;
  t.mock.method(RewriteScanner.prototype, 'scanFiles', function (this: RewriteScanner, filenames: readonly string[]) {
    const scanned = scanFiles.call(this, filenames);
    return { ...scanned, files: new Map([...scanned.files].map(([name, result]) => [name, corrupted(result)])) };
  });
}
