import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The worker reaches the shared folder through a folder link. The link is not committed.
const link = fileURLToPath(new URL('./apps/worker/shared', import.meta.url));
try {
  fs.lstatSync(link);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  fs.symlinkSync('../../shared', link, 'dir');
}
