import type { TestContext } from 'node:test';

import { observeTooling } from '#golem/observe';
import type { FileScanResult } from '#golem/rewrite-scan';

/** The result with every edit expecting text the file does not hold: applying it is an inconsistent rewrite. */
function corrupted(result: FileScanResult): FileScanResult {
  return { ...result, edits: result.edits.map((edit) => ({ ...edit, expect: `${edit.expect}\u0000not in the file` })) };
}

/** Makes every scan of the scanner, by file or by program, answer edits that no longer match their text. */
export function corruptScans(t: TestContext): void {
  const observing = observeTooling({ fileScanned: corrupted });
  t.after(() => observing[Symbol.dispose]());
}
